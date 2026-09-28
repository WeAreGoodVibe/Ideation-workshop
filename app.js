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
  /* Content a workshop must bring itself. SEED only supplies vocabulary
     (surfaces, build types, statuses, the question bank) to a workshop from
     the backend; systems, phases and prepared blind spots start empty so
     nothing from one client shows up on another's board. */
  var BLANK = { systems: [], phases: [], blindSpots: [], demoTranscript: [] };
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

  var REG = window.REG, PIPE = window.PIPE;
  var S = {
    reg: REG.empty(), opportunities: [], systems: JSON.parse(JSON.stringify(CFG.systems)),
    secondAI: [], promptPacks: {}, revealed: false,
    agendaIdx: -1, blockDone: {},
    timer: { running: false, startedAt: 0, elapsedBefore: 0 },
    transcript: [], consumedChars: 0,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    updatedAt: 0
  };

  var CAP = { sample: null, mcp: null, db: null, downloads: null, probed: false };
  var UI = { view: 'runsheet', regTab: 'opps', open: {}, review: null, filter: { fn: 'All', status: 'All', q: '' }, present: false, seq: 0, sc: null };
  var RUN = { extracting: false, speech: null, wisprTimer: null, feedTimer: null, extractTimer: null, demoTimer: null, demoIdx: 0, lastCount: 0, source: 'none', log: [], failures: 0 };

  /* ------------------------------------------------------ persistence -- */
  var SHARED_KEYS = ['reg', 'systems', 'secondAI', 'promptPacks', 'revealed', 'agendaIdx', 'blockDone', 'updatedAt'];
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
      /* A board saved before the register: its flat ideas become Opportunities. */
      if (!o.reg && Array.isArray(o.opportunities) && o.opportunities.length) S.reg = legacyToRegister(o.opportunities);
      S.reg = Object.assign(REG.empty(), S.reg || {});
      syncOps();
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
      S.reg = Object.assign(REG.empty(), S.reg || {}); syncOps();
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
  /* The end of an AI job, said plainly: while ideas stream in the room can't
     tell whether more are coming, so the status line keeps saying "done" and
     when, and a toast says so if the job put anything on the board. */
  function aiDone(what, bits, quiet) {
    var at = new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Melbourne' }).replace(/\s?(am|pm)/i, function (m) { return m.trim().toLowerCase(); });
    var got = bits.length ? bits.join(', ') : 'nothing new';
    setAiStatus(RUN.source !== 'none' ? 'live' : 'idle', what + ' done ' + at + ': ' + got);
    if (!quiet || bits.length) toast(what + ' done: ' + got + '. That is everything from this pass.');
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
  /* Facilitators edit anything; a participant edits what they added. */
  function canEdit(row) { if (MODE.role !== 'participant') return true; return !!(row && row.createdBy && SB.user && row.createdBy === SB.user.id && (row.source || 'Participant') === 'Participant'); }
  function whoChip(row) { var src = row.source || 'Facilitator'; return src === 'AI' ? chip('chip--src-AI', 'Heard by Claude') : chip('chip--src-' + src, row.addedBy ? 'Added by ' + row.addedBy : (src === 'Participant' ? 'Added by a participant' : 'Facilitator')); }
  function brandLines() { $('#brandClient').textContent = (CFG.client && CFG.client.name) || 'Ideation Board'; var sub = $('#brandSub'); if (sub) sub.textContent = teamsSentence() + '. AI opportunity workshop.'; }
  function teamsSentence() { var f = (CFG.client && CFG.client.functions) || []; return f.length ? f.join(' and ') + (f.length === 1 ? ' team' : ' teams') : 'the team'; }
  function fnEnum() { return CFG.functionsTags.join('|'); }
  function contextBlock() {
    var c = CFG.client;
    return [
      'CLIENT: ' + c.name + (c.about ? ' (' + c.about + ')' : '') + '. Workshop with the ' + teamsSentence() + '.',
      'NORTH STAR: ' + c.northStar + '.',
      'SCOPE: ' + c.scopeCriterion,
      'SYSTEMS IN PLAY: ' + (S.systems.length ? S.systems.map(function (s) { return s.name + ' (' + s.category + ', connector: ' + s.connector + ')'; }).join('; ') : 'none listed yet; name the systems the transcript mentions') + '.',
      CFG.phases.length
        ? 'PROCESS PHASES (use these names exactly for "phase"): ' + CFG.phases.map(function (p) { return p.name; }).join(' | ') + '.'
        : 'PROCESS PHASES: none defined yet. For "phase" write the process stage in two to four words, in the client\'s own terms (for example "Month-end close").',
      'FUNCTIONS (pick one for "function"): ' + fnEnum() + '.',
      'CLAUDE SURFACES (pick one for "surface"): ' + CFG.surfaces.map(function (s) { return s.key + ' = ' + s.tell; }).join('; ') + '.',
      'BUILD TYPES: Skill = a written procedure Claude follows on demand; Scheduled task = a prompt that runs on a timer with connectors; Setup = connect a system or load a Project; Project = a standing context with instructions and files; Workflow redesign = the human steps change, Claude carries a stage.'
    ].join('\n');
  }

  /* The prompts are versioned files in prompts/, chosen by prompts/index.json,
     so the page, the server and the eval all run the same words. */
  var TPL = {};
  function template(name) {
    if (TPL[name]) return Promise.resolve(TPL[name]);
    return fetch('prompts/index.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('index ' + r.status); return r.json(); })
      .then(function (idx) { return fetch('prompts/' + idx[name], { cache: 'no-store' }); })
      .then(function (r) { if (!r.ok) throw new Error(name + ' prompt ' + r.status); return r.text(); })
      .then(function (t) { TPL[name] = t; return t; })
      .catch(function (e) { throw { code: 'no_prompt', message: 'Could not load the ' + name + ' prompt from prompts/ (' + (e.message || e) + ')' }; });
  }

  /* Systems and phases heard in the transcript: add what is new, by name.
     Systems land as "assumed" so the room still has to confirm them; phases
     land in the workshop's config so the process walk grows as they talk. */
  function addHeardSystems(list) {
    var have = {}; S.systems.forEach(function (s) { have[norm(s.name)] = true; });
    var added = 0;
    (list || []).forEach(function (x) {
      var name = String((x && x.name) || '').trim(); if (!name || have[norm(name)]) return;
      have[norm(name)] = true; added++;
      var sys = { name: name, category: String(x.category || ''), usedBy: String(x.usedBy || ''), connector: 'Unknown', status: 'assumed', note: String(x.note || ''), sort: 50 + S.systems.length + added, source: 'AI', addedBy: 'Claude' };
      if (SBA()) SB.insertSystem(sys).catch(function () {});
      else S.systems.push(Object.assign({ id: 's' + uid() }, sys));
    });
    return added;
  }
  function addHeardPhases(list) {
    var have = {}; CFG.phases.forEach(function (p) { have[norm(p.name)] = true; });
    var added = 0;
    (list || []).slice(0, 2).forEach(function (x) {
      var name = String((x && x.name) || '').trim(); if (!name || have[norm(name)]) return;
      have[norm(name)] = true; added++;
      var fn = CFG.functionsTags.indexOf(x['function']) >= 0 ? x['function'] : (CFG.functionsTags.indexOf(x.fn) >= 0 ? x.fn : CFG.functionsTags[0]);
      var ph = { fn: fn, name: name, what: String(x.what || ''), prompts: [], source: 'AI', addedBy: 'Claude' };
      if (SBA()) SB.insertPhase(ph).catch(function () {}); else CFG.phases.push(Object.assign({ id: 'p' + uid() }, ph));
    });
    return added;
  }

  /* onItem, when given, is called with each finished item as the reply
     streams in (see jsonItems). The promise still resolves with the whole
     parsed reply, so a caller can tell what it has already placed. */
  /* mode: capture (live reads), second2 (the second viewpoint),
     consolidate (tidy the whole register) or prompts (build packs). Each has
     its own schema, effort and ceiling, the same as the server's. */
  var AI_MODES = {
    capture: { effort: 'low', max: 16000, schema: function () { return PIPE.captureSchema(CFG.functionsTags); }, tier: 'quick' },
    second2: { effort: 'high', max: 32000, schema: function () { return PIPE.captureSchema(CFG.functionsTags); }, tier: 'complex' },
    consolidate: { effort: 'high', max: 64000, schema: function () { return PIPE.consolidateSchema(CFG.functionsTags); }, tier: 'complex' },
    prompts: { effort: 'low', max: 32000, schema: null, tier: 'quick' }
  };
  function askJSON(prompt, mode, onItem) {
    var M = AI_MODES[mode] || AI_MODES.capture;
    var feed = onItem ? jsonItems(onItem) : null;
    if (CAP.sample) {
      return CAP.sample.json(prompt, { modelTier: M.tier, cache: false });
    }
    if (serverAI()) {
      if (!feed) return SB.api(mode, prompt, { functions: CFG.functionsTags });
      return SB.api(mode, prompt, { functions: CFG.functionsTags }, feed).then(function (r) { return typeof r === 'string' ? parseLooseJSON(r) : r; });
    }
    var key = S.settings.apiKey;
    if (!key) return Promise.reject({ code: 'no_key', message: 'No API key' });
    var body = { model: S.settings.model || 'claude-opus-5', max_tokens: M.max, output_config: { effort: M.effort }, messages: [{ role: 'user', content: prompt }] };
    if (M.schema) body.output_config.format = { type: 'json_schema', schema: M.schema() };
    if (feed) body.stream = true;
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (feed && r.ok && r.body) return readClaudeStream(r, feed).then(parseLooseJSON);
      return r.json().then(function (j) { if (!r.ok) throw { code: 'http_' + r.status, message: (j.error && j.error.message) || r.statusText }; return j; });
    }).then(function (j) {
      if (j && !j.content) return j;
      if (j.stop_reason === 'refusal') throw { code: 'refused', message: 'The model declined this window.' };
      var text = (j.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
      return parseLooseJSON(text);
    });
  }
  /* Claude's own event stream, read straight from the browser: feed gets
     each piece of text, and the promise resolves with the whole reply. */
  function readClaudeStream(r, feed) {
    var reader = r.body.getReader(), decoder = new TextDecoder(), buf = '', whole = '', stop = null;
    function block(b) {
      var data = b.split('\n').filter(function (l) { return l.indexOf('data:') === 0; }).map(function (l) { return l.slice(5).trim(); }).join('');
      if (!data) return;
      var ev; try { ev = JSON.parse(data); } catch (e) { return; }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { whole += ev.delta.text; feed(ev.delta.text); }
      else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
      else if (ev.type === 'error') throw { code: 'stream', message: (ev.error && ev.error.message) || 'Stream error' };
    }
    function pump() {
      return reader.read().then(function (step) {
        if (!step.done) buf += decoder.decode(step.value, { stream: true });
        var i; while ((i = buf.indexOf('\n\n')) >= 0) { block(buf.slice(0, i)); buf = buf.slice(i + 2); }
        if (!step.done) return pump();
        if (buf.trim()) block(buf);
        if (stop === 'refusal') throw { code: 'refused', message: 'The model declined this window.' };
        if (stop === 'max_tokens') throw { code: 'max_tokens', message: 'The reply ran out of room before it finished.', text: whole };
        return whole;
      });
    }
    return pump();
  }
  function parseLooseJSON(text) {
    try { return JSON.parse(text); } catch (e) {}
    var m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    var a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
    throw { code: 'invalid_json', message: 'No JSON in reply', text: text };
  }

  /* Reads a JSON reply while it is still being written and calls
     onItem(key, item) the moment each object inside a top-level array is
     whole, for example ("opportunities", {...}). That is what lets an idea
     land on the board before the rest of the reply has arrived. The finished
     reply is still parsed in full at the end; this only gets there sooner. */
  function jsonItems(onItem) {
    var buf = '', pos = 0, depth = 0, inStr = false, esc = false, lastStr = '', strStart = -1, key = '', start = -1;
    return function (text) {
      buf += text;
      for (; pos < buf.length; pos++) {
        var c = buf[pos];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') { inStr = false; if (depth === 1) lastStr = buf.slice(strStart + 1, pos); }
          continue;
        }
        if (c === '"') { inStr = true; strStart = pos; }
        else if (c === ':' && depth === 1) key = lastStr;
        else if (c === '{' || c === '[') { depth++; if (c === '{' && depth === 3) start = pos; }
        else if (c === '}' || c === ']') {
          if (c === '}' && depth === 3 && start >= 0) {
            var item = null; try { item = JSON.parse(buf.slice(start, pos + 1)); } catch (e) {}
            start = -1;
            if (item) { try { onItem(key, item); } catch (e) { log('Could not place a streamed item: ' + (e && e.message)); } }
          }
          depth = Math.max(0, depth - 1);
        }
      }
    };
  }

  function scheduleExtract() {
    clearTimeout(RUN.extractTimer);
    var pending = fullTranscript().length - S.consumedChars;
    var wait = pending >= S.settings.minChars * 3 ? 1500 : S.settings.pollSec * 1000;
    /* After a failure, back off: the same window will fail the same way, and
       a server that is misconfigured gains nothing from a call every second. */
    if (RUN.failures) wait = Math.max(wait, Math.min(120000, 10000 * Math.pow(2, RUN.failures - 1)));
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
    /* Each capture is placed on the register the moment the stream finishes
       writing it, so the room sees detail land under its workflow one by
       one. The whole window is saved as one change at the end. */
    var before = REG.clone(S.reg), keys = {};
    var seen = { captures: 0, systems: 0, phases: 0 }, tally = { created: 0, attached: 0, merged: 0, enabler: 0, learning: 0, triaged: 0 }, systemsAdded = 0, phasesAdded = 0;
    function place(key, item) {
      if (key === 'captures') {
        var r = REG.applyCapture(S.reg, PIPE.toCapture(item, 'live'), { keys: keys, createdBy: 'live' });
        tally[r.action] = (tally[r.action] || 0) + 1;
        syncOps(); updateBadge(true); renderSoon();
        var what = { created: 'New workflow ' + r.id, attached: 'Added to ' + String(r.id).split('.')[0], merged: 'More evidence on ' + r.id, enabler: 'Enabler ' + r.id, learning: 'Learning ' + r.id, triaged: 'To sort: ' + r.id }[r.action] || r.action;
        toast(what + ': ' + String(item.title || item.text || '').slice(0, 70));
      }
      else if (key === 'systems') systemsAdded += addHeardSystems([item]);
      else if (key === 'phases') { if (phasesAdded < 2) phasesAdded += addHeardPhases([item]); }
      else return;
      seen[key]++;
      setAiStatus('busy', 'AI reading… ' + seen.captures + ' heard so far');
    }
    return template('extract').then(function (tpl) {
      return askJSON(PIPE.extractPrompt(tpl, { context: contextBlock(), register: S.reg, window: windowText }), 'capture', place);
    })
      .then(function (j) {
        ['captures', 'systems', 'phases'].forEach(function (k) {
          ((j && j[k]) || []).slice(seen[k]).forEach(function (item) { place(k, item); });
        });
        S.consumedChars = consumedTo;
        commit(before);
        if (SBA()) SB.updateWorkshop({ consumed_chars: consumedTo }).catch(function () {});
        var bits = [];
        if (tally.created) bits.push('+' + tally.created + ' workflow' + (tally.created > 1 ? 's' : ''));
        if (tally.attached) bits.push(tally.attached + ' detail' + (tally.attached > 1 ? 's' : '') + ' attached');
        if (tally.merged) bits.push(tally.merged + ' repeat' + (tally.merged > 1 ? 's' : '') + ' kept as evidence');
        if (tally.enabler) bits.push(tally.enabler + ' enabler' + (tally.enabler > 1 ? 's' : ''));
        if (tally.learning) bits.push(tally.learning + ' learning');
        if (tally.triaged) bits.push(tally.triaged + ' to sort');
        if (systemsAdded) bits.push('+' + systemsAdded + ' system' + (systemsAdded > 1 ? 's' : ''));
        if (phasesAdded) bits.push('+' + phasesAdded + ' phase' + (phasesAdded > 1 ? 's' : ''));
        log('AI heard ' + seen.captures + ': ' + (bits.join(', ') || 'nothing new'));
        if ((systemsAdded || phasesAdded) && !SBA()) render();
        RUN.failures = 0;
        aiDone('AI read', bits, !force);
      })
      .catch(function (e) {
        /* Whatever landed before the failure is kept and saved. */
        if (seen.captures) commit(before);
        RUN.failures++;
        var msg = (e && (e.code + ' ' + e.message)) || String(e);
        log('AI error: ' + msg);
        setAiStatus('bad', 'AI error, see Live' + (RUN.failures > 1 ? ' (' + RUN.failures + ' in a row, retrying slower)' : ''));
        if (RUN.failures === 1) toast('AI read failed: ' + String((e && e.message) || e).slice(0, 140));
        if (e && e.code === 'not_granted') { CAP.sample = null; setModeStatus(); }
      })
      .then(function () { RUN.extracting = false; updateTiles(); afterBusy(); if (S.settings.autoExtract) scheduleExtract(); });
  }

  /* The second viewpoint writes into the register too, as Proposed: new
     workflows the room did not raise, and details the room missed on the
     workflows it did. A Proposed Opportunity only counts once the client
     confirms it. The idea cards on the reveal are the new workflows, with
     the reason each one did not come up. */
  function confLabel(c) { c = Number(c); return c >= 0.8 ? 'High' : c >= 0.6 ? 'Medium' : 'Low'; }
  function generateSecond() {
    if (!aiAvailable()) { toast('AI is off; showing the consultant list only'); return Promise.resolve(); }
    var t = fullTranscript(); if (t.length > 52000) t = t.slice(-52000);
    if (t.length < 400) { toast('Not enough transcript for an AI pass; consultant list only'); return Promise.resolve(); }
    setAiStatus('busy', 'AI writing the second viewpoint…');
    /* Captures are kept as they stream, so a reply that is cut off part way
       still gives the room every one that was finished. */
    var streamed = [];
    return template('second').then(function (tpl) {
      return askJSON(PIPE.secondPrompt(tpl, { context: contextBlock(), register: S.reg, transcript: t }), 'second2', function (key, c) {
        if (key !== 'captures') return;
        streamed.push(c);
        setAiStatus('busy', 'AI writing the second viewpoint… ' + streamed.length + ' so far');
      });
    })
      .catch(function (e) {
        if (e && (e.code === 'max_tokens' || e.code === 'invalid_json') && streamed.length) {
          log('Second viewpoint was cut off; keeping the ' + streamed.length + ' finished captures');
          return { captures: streamed };
        }
        throw e;
      })
      .then(function (j) {
        var caps = (j && j.captures) || [];
        var results = change(function (reg) {
          return REG.applyCaptures(reg, caps.map(function (c) { return PIPE.toCapture(c, 'second viewpoint'); }), { origin: 'Proposed', createdBy: 'second viewpoint' });
        }) || [];
        var n = 0;
        S.secondAI = results.filter(function (r) { return r.capture.type === 'opportunity'; }).map(function (r) {
          var c = r.capture; n++;
          return { id: 'A' + n, title: c.title || c.text, fn: c.fn || 'Both', phase: c.phase, surface: c.surface, build: '', what: c.claudeDoes || c.text,
            why: c.why, lift: '', comparator: c.comparator, confidence: confLabel(c.confidence), opp: r.action === 'created' || r.action === 'merged' ? r.id : '' };
        });
        var kids = results.filter(function (r) { return r.action === 'attached'; }).length;
        save(); log('Second viewpoint: ' + S.secondAI.length + ' new workflows, ' + kids + ' details on existing ones');
        if (SBA()) SB.setAIIdeas(S.secondAI).catch(function () {});
        aiDone('Second viewpoint', [S.secondAI.length + ' new workflow' + (S.secondAI.length === 1 ? '' : 's'), kids + ' detail' + (kids === 1 ? '' : 's') + ' on existing ones']);
      })
      .catch(function (e) {
        log('Second viewpoint error: ' + (e && (e.code + ' ' + e.message)));
        setAiStatus('bad', 'Second viewpoint failed, see Live');
        toast('Second viewpoint failed: ' + String((e && e.message) || e).slice(0, 140));
      });
  }

  /* ------------------------------------------------- prompts and skills -- */
  /* The board says what to build. This writes the thing that builds it.
     Three artefacts per opportunity, because they are used at three
     different moments: an interview that pulls the detail out of the person
     who owns the work, the artefact itself, and the first message to send
     once it exists. They live in the workshop config so every screen sees
     them and the export picks them up. */
  function packs() { return (SBA() ? (CFG.promptPacks || {}) : (S.promptPacks || {})) || {}; }
  function packFor(o) { return packs()[o.id] || null; }
  function savePacks(map) {
    if (SBA()) {
      CFG.promptPacks = map;
      var cfg = Object.assign({}, (SB.ws && SB.ws.config) || {});
      cfg.promptPacks = map;
      return SB.updateWorkshop({ config: cfg }).catch(function (e) { log('packs not saved: ' + (e && e.message)); });
    }
    S.promptPacks = map; save();
    return Promise.resolve();
  }

  /* Which ideas get a pack: the ones the room landed on. Validated first,
     then the best voted, and never an idea that was parked or merged away. */
  function packCandidates() {
    return S.opportunities.filter(function (o) { return o.status !== 'Parked' && (o.origin !== 'Proposed' || o.confirmed); })
      .sort(function (a, b) { return (b.status === 'Qualified') - (a.status === 'Qualified') || (b.votes - a.votes) || (a.createdAt - b.createdAt); });
  }

  function promptsPrompt(ops) {
    var rows = ops.map(function (o) {
      var kids = REG.childrenOf(S.reg, o.id).filter(function (i) { return !i.auto; });
      var of = function (t) { return kids.filter(function (i) { return i.type === t; }).map(function (i) { return i.text; }); };
      return { id: o.id, title: o.title, team: o.fn, phase: o.phase, surface: o.surface, build: o.build,
        pain: o.pain, whatClaudeDoes: o.direction, systems: o.systems, quote: o.quote, raisedBy: o.raisedBy, owner: o.owner, trigger: o.frequency, timePerRound: o.timeBand, notes: o.notes,
        buildSteps: of('build_step'), guardrails: of('guardrail'), dependencies: of('dependency'), setupActions: of('setup_action'), openQuestions: of('open_question') };
    });
    return [
      'You are the consultant who has to turn a workshop shortlist into things that get built. For each opportunity below, write what the person who owns that work can use on Monday morning with no further help from you.',
      contextBlock(),
      'For EVERY opportunity, return one pack with these fields.',
      '"kind": which of Skill, Scheduled task, Project, Setup, Workflow redesign the artefact is. Start from the opportunity\'s build type if it has one and keep it unless it is plainly wrong for what the idea actually needs.',
      'Each opportunity carries the detail the room gave under it: buildSteps, guardrails, dependencies, setupActions and openQuestions. Every guardrail must appear in the artefact as a rule it never breaks; every build step must be covered; open questions become questions in the interview.',
      '"artefactName": a short file or task name, lower case with hyphens, for example "supplier-invoice-triage".',
      '"interview": a prompt that the owner of the work pastes into Claude so Claude interviews THEM. It is addressed to Claude in the second person and it must: give Claude the role and the goal; say to ask one question at a time and wait for the answer; say to push back on a vague answer and ask for a real example; name eight to fifteen specific questions covering the trigger, the inputs and exactly where they live, the decision rules, the exceptions and edge cases, what a good output looks like, who checks it, how often it runs, and what must never happen; and finish by telling Claude to write the finished artefact from the answers. 200 to 350 words.',
      '"artefact": the thing itself, ready to paste, in Markdown. Shape it by kind.',
      '  Skill: a SKILL.md. First line "# <Name>", then a one-line description, then "## When to use this", "## What you need before you start", "## Steps" as a numbered procedure specific enough that two people would produce the same output, "## Output format" with the actual layout, "## Quality bar", and "## Stop and ask" listing what Claude must never decide alone.',
      '  Scheduled task: the exact prompt text to paste into a Claude scheduled task, opening with a line naming the cadence and the connectors, then the instruction, then the output and where it goes, then the rule for when there is nothing to report.',
      '  Project: the project custom instructions, plus a "## Files to add" list naming the documents to upload and why each one is there.',
      '  Setup: a numbered connection checklist naming the system, who has the admin rights, what to switch on, and how to test it worked.',
      '  Workflow redesign: the new sequence of steps, each marked "(person)" or "(Claude)", with a before and after line on how long the stage takes.',
      '"firstRun": the first message the person sends once the artefact exists, with a real-looking example input named in square brackets. Two to five sentences.',
      '"connectors": the Claude connectors, integrations or files needed, by name. Empty array when it needs none.',
      '"watchOut": one sentence on the thing most likely to go wrong the first time, and what to do about it.',
      'RULES:',
      '- Use only what the opportunity and the context above actually say. Where a detail is unknown, write a named placeholder in square brackets, for example [the shared AP mailbox], rather than inventing a fact.',
      '- Never invent a system, a person, a volume or a deadline that is not given.',
      '- Australian English. Plain words a person who has never written a prompt can follow. No em dashes.',
      '- Return "id" exactly as given so each pack matches its opportunity.',
      'OPPORTUNITIES:',
      JSON.stringify(rows, null, 1),
      'Reply with only JSON: {"packs":[{"id":"","title":"","kind":"","artefactName":"","interview":"","artefact":"","firstRun":"","connectors":[""],"watchOut":""}]}'
    ].join('\n\n');
  }

  /* Two ideas per request keeps each reply well inside the token ceiling and
     the function timeout; three requests run at a time. */
  function generatePrompts(list) {
    if (RUN.packing) { toast('Already writing. Give it a moment.'); return Promise.resolve(); }
    if (!aiAvailable()) { toast('AI is off. Add a key in Settings, or set ANTHROPIC_API_KEY on the server.'); return Promise.resolve(); }
    var ops = (list && list.length) ? list : packCandidates();
    if (!ops.length) { toast('Nothing on the board to write prompts for yet'); return Promise.resolve(); }
    var chunks = []; for (var i = 0; i < ops.length; i += 2) chunks.push(ops.slice(i, i + 2));
    var map = Object.assign({}, packs()), done = 0, failed = 0, next = 0;
    RUN.packing = { total: ops.length, done: 0 };
    setAiStatus('busy', 'Claude is writing prompts and skills…');
    renderIfPrompts();
    log('Writing prompts and skills for ' + ops.length + ' idea' + (ops.length === 1 ? '' : 's'));

    function runOne() {
      if (next >= chunks.length) return Promise.resolve();
      var chunk = chunks[next++];
      /* A pack is placed as soon as the stream has written it, and the full
         reply at the end only places the ones still missing. */
      var placed = {};
      function place(pk) {
        var o = findOp(pk.id) || chunk.filter(function (x) { return norm(x.title) === norm(pk.title); })[0];
        if (!o || placed[o.id]) return;
        placed[o.id] = true;
        map[o.id] = { id: o.id, title: o.title, kind: pk.kind || o.build, artefactName: pk.artefactName || '',
          interview: pk.interview || '', artefact: pk.artefact || '', firstRun: pk.firstRun || '',
          connectors: Array.isArray(pk.connectors) ? pk.connectors : [], watchOut: pk.watchOut || '', writtenAt: now() };
        done++;
        RUN.packing.done = done + failed;
        renderIfPrompts();
      }
      return askJSON(promptsPrompt(chunk), 'prompts', function (key, pk) { if (key === 'packs') place(pk); }).then(function (j) {
        ((j && j.packs) || []).forEach(place);
      }).catch(function (e) {
        failed += chunk.filter(function (x) { return !placed[x.id]; }).length;
        log('Prompt pack error: ' + (e && (e.code + ' ' + e.message)));
      }).then(function () {
        RUN.packing.done = done + failed;
        renderIfPrompts();
        return runOne();
      });
    }

    var lanes = []; for (var n = 0; n < Math.min(3, chunks.length); n++) lanes.push(runOne());
    return Promise.all(lanes).then(function () {
      return savePacks(map);
    }).then(function () {
      RUN.packing = null;
      log('Prompt packs written: ' + done + (failed ? ', failed: ' + failed : ''));
      if (done) aiDone('Prompt packs', [done + ' ready'].concat(failed ? [failed + ' failed'] : []));
      else { setAiStatus(RUN.source !== 'none' ? 'live' : 'idle'); toast('Nothing came back. Check the AI line in the sidebar.'); }
      render();
    });
  }
  function renderIfPrompts() { if (UI.view === 'prompts') render(); }

  /* ----------------------------------------------------------- register -- */
  /* The board is the hierarchical register (lib/register.js): Opportunities
     with typed children, Enablers, Learning and Triage. Every change goes
     through change(): the rules edit S.reg, then commit() saves the
     difference. S.opportunities is a flat read-only view of the
     Opportunities for the screens that only need a list (process walk,
     second viewpoint, prompts, export, votes). */
  var LEGACY_STATUS = { Open: 'Identified', Emerging: 'Identified', Validated: 'Qualified', Merged: 'Identified' };
  function oppStatus(o) { return LEGACY_STATUS[o.status] || o.status || 'Identified'; }
  function legacyToRegister(list) {
    var reg = REG.empty();
    (list || []).forEach(function (o) {
      var x = REG.createOpportunity(reg, { id: o.id, title: o.title, fn: o.fn || o['function'], phase: o.phase, owner: o.owner, systems: o.systems,
        problem: o.pain, claudeDoes: o.direction, surface: o.surface, notes: o.notes, status: LEGACY_STATUS[o.status] || o.status, votes: o.votes || 0,
        evidence: o.quote ? [{ quote: o.quote, speaker: o.raisedBy || '', source: 'live' }] : [] }, { createdBy: o.source === 'AI' ? 'live' : 'manual' });
      x.createdAt = o.createdAt || now(); x.source = o.source || '';
    });
    return reg;
  }
  function flatOf(o) {
    var ev0 = (o.evidence || [])[0] || {};
    return { id: o.id, uid: o.uid, title: o.title, fn: o.fn || 'Both', phase: o.phase || '', cluster: '', surface: o.surface || '', build: o.build || '',
      pain: o.problem || '', direction: o.claudeDoes || '', systems: o.systems || [], quote: ev0.quote || '', raisedBy: ev0.speaker || '',
      owner: o.owner || '', frequency: o.frequency || '', timeBand: o.timeBand || '', notes: o.notes || '', status: oppStatus(o),
      source: o.source || (o.createdBy === 'live' ? 'AI' : o.createdBy === 'second viewpoint' ? 'Consultant' : 'Room'),
      origin: o.origin || 'Client-raised', confirmed: o.confirmed !== false, votes: o.votes || 0, voters: o.voters || [], myDots: o.myDots || 0,
      value: o.value, ease: o.ease, confidence: 'Medium', createdAt: o.createdAt || 0, createdBy: o.createdByUser };
  }
  function syncOps() {
    S.reg.opportunities.forEach(function (o) { if (!o.createdAt) o.createdAt = now(); });
    S.opportunities = S.reg.opportunities.map(flatOf);
  }
  function findRegOpp(id) { return REG.findOpp(S.reg, id); }

  /* Saving. In the shared backend each change is written as the difference
     between the register before and after it, one change at a time, in
     order. A row saved once gets a database id; UIDS remembers it so a later
     save in the queue updates that row instead of inserting it again. While
     anything is queued, a reload from the server waits. */
  var REGQ = { chain: Promise.resolve(), busy: 0, reload: false, t: null };
  var UIDS = {};
  var LISTS = ['opportunities', 'items', 'enablers', 'learning', 'triage'];
  function learnUids(reg) { LISTS.forEach(function (k) { (reg[k] || []).forEach(function (x) { if (x.uid) UIDS[k + ':' + x.id] = x.uid; }); }); }
  function fillUids(reg) { LISTS.forEach(function (k) { (reg[k] || []).forEach(function (x) { if (!x.uid && UIDS[k + ':' + x.id]) x.uid = UIDS[k + ':' + x.id]; }); }); }
  function commit(before) {
    syncOps(); updateBadge(true);
    if (!SBA()) { save(); renderSoon(); return Promise.resolve(); }
    var after = REG.clone(S.reg);
    REGQ.busy++;
    REGQ.chain = REGQ.chain.then(function () {
      fillUids(before); fillUids(after);
      return SB.saveRegister(before, after);
    }).then(function (r) {
      learnUids(after); fillUids(S.reg);
      if (r && !r.ok) log('Register save stopped: ' + r.error);
    }).catch(function (e) { log('Register save failed: ' + (e && e.message || e)); })
      .then(function () { REGQ.busy--; if (!REGQ.busy) reloadRegister(); });
    renderSoon();
    return REGQ.chain;
  }
  /* Run fn on the register and save the result. fn may throw to refuse the
     change; the register is then left exactly as it was. */
  function change(fn) {
    var before = REG.clone(S.reg), out;
    try { out = fn(S.reg); } catch (e) { S.reg = before; syncOps(); toast(String((e && e.message) || e)); return null; }
    commit(before);
    return out === undefined ? true : out;
  }
  function reloadRegister() {
    if (!SBA()) return;
    clearTimeout(REGQ.t);
    REGQ.t = setTimeout(function () {
      if (REGQ.busy || RUN.extracting) { REGQ.reload = true; return; }
      SB.loadRegister().then(function (reg) {
        if (!reg || REGQ.busy || RUN.extracting) { if (reg) REGQ.reload = true; return; }
        var mine = SB.myDots || {};
        reg.opportunities.forEach(function (o) { o.myDots = mine[o.uid] || 0; });
        learnUids(reg);
        S.reg = reg; REGQ.reload = false;
        syncOps(); updateBadge(true); renderSoon();
      });
    }, 300);
  }
  function afterBusy() { if (REGQ.reload && !REGQ.busy && !RUN.extracting) reloadRegister(); }

  /* ------------------------------------------------------ opportunities -- */
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
  /* The one rule for "this is the same idea": an exact match on the
     normalised title, or one title containing the other once it is long
     enough for that to mean something. addOpportunity refuses a duplicate on
     it, and the second viewpoint reads the same rule to know an idea has
     already landed, so the two can never drift apart. */
  function sameIdea(existingNorm, incomingNorm) {
    return existingNorm === incomingNorm ||
      (existingNorm.length > 12 && (existingNorm.indexOf(incomingNorm) >= 0 || incomingNorm.indexOf(existingNorm) >= 0));
  }
  /* The opportunity a second viewpoint idea became, or null while it is still
     only an idea. Read from the board itself rather than a flag, so it stays
     honest if the opportunity is later deleted or renamed. */
  function promotedAs(idea) {
    var t = norm(idea && idea.title); if (!t) return null;
    for (var i = 0; i < S.opportunities.length; i++) {
      if (sameIdea(norm(S.opportunities[i].title), t)) return S.opportunities[i];
    }
    return null;
  }
  function addedWhen(ts) {
    if (!ts) return '';
    var d = new Date(ts), opts = { hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Melbourne' };
    var today = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne' });
    if (d.toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne' }) !== today) { opts.day = 'numeric'; opts.month = 'short'; }
    return d.toLocaleString('en-AU', opts).replace(/\s?(am|pm)/i, function (m) { return m.toLowerCase(); });
  }

  /* One idea onto the register by hand, from a feed, an import or a
     participant's phone. It goes through the same rule as live capture, so
     the same workflow said twice becomes evidence on the first, not a second
     row. A participant cannot write the register tables, so their idea goes
     in as a plain Opportunity row, which the register then reads. */
  function addOpportunity(o, source) {
    var title = String(o.title || '').trim(); if (!title) return false;
    var fn = CFG.functionsTags.indexOf(o['function']) >= 0 ? o['function'] : (o.fn || 'Both');
    if (SBA() && MODE.role === 'participant') {
      SB.insertOpportunity({ title: title, fn: fn, phase: o.phase || '', surface: o.surface || '', pain: o.pain || '', direction: o.direction || '',
        systems: o.systems || [], quote: o.quote || '', raisedBy: o.raisedBy || '', status: 'Identified', source: source || 'Participant' }).catch(function () {});
      return true;
    }
    var r = change(function (reg) {
      var res = REG.applyCapture(reg, { type: 'opportunity', confidence: 1, title: title, text: title, fn: fn, phase: o.phase || '', owner: o.owner || '',
        frequency: o.frequency || '', timeBand: o.timeBand || '', systems: Array.isArray(o.systems) ? o.systems : String(o.systems || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean),
        problem: o.pain || '', claudeDoes: o.direction || '', surface: o.surface || '',
        evidence: o.quote ? [{ quote: o.quote, speaker: o.raisedBy || '', source: source === 'AI' ? 'live' : 'manual' }] : [] },
        { createdBy: source === 'AI' ? 'live' : 'manual', origin: o.origin });
      var made = res.action === 'created' && REG.findOpp(reg, res.id);
      if (made) { made.source = source || 'Room'; if (o.notes) made.notes = o.notes; if (o.origin === 'Proposed') made.confirmed = !!o.confirmed; }
      return res;
    });
    return !!(r && r.action === 'created');
  }
  function pushOp(o, fields) {
    if (!SBA() || !o.uid) return;
    var patch = {}; fields.forEach(function (f) { patch[f] = o[f]; });
    SB.updateOpportunity(o.uid, patch).catch(function () {});
  }
  function pushSys(sys) { if (SBA() && sys.uid) SB.updateSystem(sys.uid, sys).catch(function () {}); }
  function findOp(id) { for (var i = 0; i < S.opportunities.length; i++) if (S.opportunities[i].id === id) return S.opportunities[i]; return null; }
  function updateBadge(bump) {
    var n = REG.countedOpportunities(S.reg).length;
    var b = $('#opBadge'); b.textContent = n; b.classList.toggle('badge--zero', n === 0);
    if (bump && n !== RUN.lastCount) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
    RUN.lastCount = n;
    $('#secondLock').textContent = S.revealed ? 'open' : 'locked';
    document.title = (n ? n + ' workflows · ' : '') + 'Ideation Board';
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
    if (view === 'second') UI.scJump = true;
    UI.view = view;
    $$('.navbtn').forEach(function (b) { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    window.scrollTo(0, 0);
    render();
  }
  /* What the revealed second viewpoint is built from. While this is unchanged
     a data refresh must not touch the DOM: the scroll engine is driving those
     nodes, and replacing them leaves the reader with blank, undriven copy the
     moment they scroll back up. */
  function secondSig() {
    var raised = S.opportunities.filter(function (o) { return o.status !== 'Parked' && o.origin !== 'Proposed'; });
    var ideas = (CFG.blindSpots || []).concat(S.secondAI || []);
    return JSON.stringify([UI.seq, MODE.role, raised.length, raised.map(function (o) { return o.fn; }).sort().join(''),
      CFG.blindSpots.map(function (i) { return i.id; }).join('|'), S.secondAI.map(function (i) { return i.id + i.title; }).join('|'),
      /* which ideas have landed on the board, so the card state cannot go stale */
      ideas.map(function (i) { var on = promotedAs(i); return on ? i.id + '>' + on.id : ''; }).join('|')]);
  }
  function render() {
    var root = $('#view');
    var fn = { runsheet: vRunsheet, systems: vSystems, process: vProcess, opportunities: vOpportunities, second: vSecond, prompts: vPrompts, live: vLive, settings: vSettings }[UI.view] || vRunsheet;
    if (UI.view === 'second' && S.revealed) {
      var sig = secondSig();
      if (UI.sc && root.getAttribute('data-sc-sig') === sig && root.firstChild) return;
      root.setAttribute('data-sc-sig', sig);
    } else root.removeAttribute('data-sc-sig');
    root.innerHTML = fn();
    afterRender();
  }
  function afterRender() {
    if (UI.sc) { try { UI.sc.destroy(); } catch (e) {} UI.sc = null; }
    if (UI.view === 'second' && S.revealed && window.ScrollCraft) {
      UI.sc = window.ScrollCraft.mount($('#view'));
      /* Opening the view lands on the pinned stage straight away. Left at
         scroll 0 the stage starts below the nav, so on a phone the first
         screen is mostly empty canvas with the number at the bottom. */
      if (UI.scJump) { var act = $('.reveal'); if (act) window.scrollTo({ top: act.getBoundingClientRect().top + window.scrollY, behavior: 'instant' }); }
    }
    UI.scJump = false;
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
      html += '<div class="card joincard" data-who="room" data-tip="Show this to the room in block 1. Everyone scans the square with their phone camera, types their name and is in. No email, no password. The link and code are the fallback for a phone that will not scan."><div class="joincard__qr" data-action="bigqr" title="Show it big">' + qrSvg(joinLink()) + '</div><div><div class="k">Scan to join, or open the link</div><div class="joincard__url">' + esc(joinLink()) + '</div></div><div><div class="k">Code</div><div class="joincard__code">' + esc(SB.ws.join_code) + '</div></div><div class="fac stack"><button class="btn btn--sm" data-action="bigqr">Show big</button><button class="btn btn--sm btn--ghost" data-action="copylink">Copy link</button></div></div>';
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
    var html = head('What you touch', 'Assumed until the room confirms it. The connector column is the seam Claude has to cross. Anyone in the room can add one; Claude adds the ones it hears.',
      '<button class="btn" data-action="addsystem" data-tip="Add a system the team uses. It shows for everyone straight away with your name on it." data-who="both">Add a system</button>');
    if (!S.systems.length) html += '<div class="card empty" data-who="you"><h3>No systems yet</h3><p class="muted">This workshop starts blank. Add the systems this team touches (the ERP, the document store, the mailbox, the spreadsheets) before the day, or build the list live in block 2 while the room corrects you.</p></div>';
    html += '<div class="grid grid--3">';
    S.systems.forEach(function (s) {
      html += '<div class="card sys" data-sys="' + esc(s.id) + '"><div><div class="sys__name">' + esc(s.name) + '</div><div class="sys__meta">' + chip('chip--st-' + s.status, s.status) + chip('', s.category) + chip('', s.usedBy) + whoChip(s) + '</div>' +
        '<div class="sys__note"><b>Claude reach:</b> ' + esc(s.connector) + '<br>' + esc(s.note) + '</div></div>' +
        '<div class="stack"><div class="seg fac" data-sysstatus="' + esc(s.id) + '">' + ['confirmed', 'assumed', 'unknown'].map(function (st) { return '<button aria-pressed="' + (s.status === st) + '" data-st="' + st + '">' + st[0].toUpperCase() + '</button>'; }).join('') + '</div>' + (canEdit(s) ? '<button class="btn btn--sm btn--ghost" data-action="editsystem" data-id="' + esc(s.id) + '">Edit or delete</button>' : '') + '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function vProcess() {
    var html = head('Process walk', 'Phase by phase. The number is how many opportunities have landed on that phase: the heat map builds itself. Anyone in the room can add a phase; Claude adds the stages it hears.',
      '<button class="btn" data-action="addphase" data-tip="Add a stage of your process. It shows for everyone straight away with your name on it." data-who="both">Add a phase</button>');
    if (!CFG.phases.length) html += '<div class="card empty" data-who="you"><h3>No phases yet</h3><p class="muted">This workshop starts blank. Add the process phases for each team (for example "Accounts payable", "Month-end close", "Purchase orders") before the day. Ideas Claude hears before then are listed below under "Not yet placed" and can be moved onto a phase later.</p></div>';
    var groups = CFG.functionsTags.slice(); CFG.phases.forEach(function (p) { if (groups.indexOf(p.fn) < 0) groups.push(p.fn); });
    groups.forEach(function (fn) {
      var ps = CFG.phases.filter(function (p) { return p.fn === fn; }); if (!ps.length) return;
      html += '<h2 style="margin:var(--sc-6) 0 var(--sc-3)">' + esc(fn === 'Both' ? 'Cross-cutting' : fn) + '</h2><div class="grid grid--2">';
      ps.forEach(function (p) {
        var ops = opCountFor(p.name);
        html += '<div class="card phase" data-phase="' + esc(p.id) + '"><div><h3>' + esc(p.name) + '</h3><div class="sys__meta">' + whoChip(p) + '</div><p class="phase__what">' + esc(p.what || '') + '</p>' +
          '<ul class="phase__prompts fac">' + (p.prompts || []).map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>' +
          (ops.length ? '<div class="phase__ops">' + ops.map(function (o) { return chip('chip--fn-' + o.fn, o.id + ' ' + o.title); }).join('') + '</div>' : '') +
          '<div class="row" style="margin-top:10px"><button class="btn btn--sm fac" data-action="newop" data-phase="' + esc(p.name) + '" data-fn="' + esc(p.fn) + '">Add opportunity here</button>' + (canEdit(p) ? '<button class="btn btn--sm btn--ghost" data-action="editphase" data-id="' + esc(p.id) + '">Edit or delete</button>' : '') + '</div></div>' +
          '<div class="phase__count' + (ops.length ? '' : ' zero') + '">' + ops.length + '</div></div>';
      });
      html += '</div>';
    });
    var placed = {}; CFG.phases.forEach(function (p) { placed[p.name] = true; });
    var loose = S.opportunities.filter(function (o) { return !placed[o.phase] && o.status !== 'Merged'; });
    if (loose.length) {
      var byPhase = {}; loose.forEach(function (o) { var k = o.phase || 'No phase'; (byPhase[k] = byPhase[k] || []).push(o); });
      html += '<h2 style="margin:var(--sc-6) 0 var(--sc-3)">Not yet placed on a phase</h2><p class="muted small fac">Claude named these stages from the transcript. Add a phase with the same name to adopt them, or edit each idea and pick a phase.</p><div class="grid grid--2">';
      Object.keys(byPhase).forEach(function (k) {
        var ops = byPhase[k];
        html += '<div class="card phase"><div><h3>' + esc(k) + '</h3><div class="phase__ops">' + ops.map(function (o) { return chip('chip--fn-' + o.fn, o.id + ' ' + o.title); }).join('') + '</div>' +
          (k !== 'No phase' ? '<div class="row" style="margin-top:10px"><button class="btn btn--sm" data-action="adoptphase" data-name="' + esc(k) + '" data-fn="' + esc(ops[0].fn) + '">Make this a phase</button></div>' : '') + '</div>' +
          '<div class="phase__count">' + ops.length + '</div></div>';
      });
      html += '</div>';
    }
    return html;
  }

  /* ----------------------------------------------------- register views -- */
  var TYPE_PLURAL = { build_step: 'Build steps', guardrail: 'Guardrails', dependency: 'Dependencies', setup_action: 'Setup actions', open_question: 'Open questions' };
  var FAC = function () { return MODE.role !== 'participant'; };
  function filteredOps() {
    var f = UI.filter, q = norm(f.q);
    return S.reg.opportunities.filter(function (o) {
      if (f.fn !== 'All' && o.fn !== f.fn) return false;
      if (f.status === 'Blocked') { if (!REG.isBlocked(S.reg, o.id)) return false; }
      else if (f.status === 'Needs qualification') { if (!REG.needsQualification(o)) return false; }
      else if (f.status === 'Proposed') { if (!(o.origin === 'Proposed' && !o.confirmed)) return false; }
      else if (f.status !== 'All' && oppStatus(o) !== f.status) return false;
      if (q) {
        var kids = REG.childrenOf(S.reg, o.id).map(function (i) { return i.text; }).join(' ');
        if (norm([o.id, o.title, o.problem, o.claudeDoes, o.phase, o.owner, kids].join(' ')).indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) { return ((b.status === 'Parked') ? -1 : 0) - ((a.status === 'Parked') ? -1 : 0) || ((b.votes || 0) - (a.votes || 0)) || (parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10)); });
  }
  function regTabs() {
    var tabs = [['opps', 'Workflows', REG.countedOpportunities(S.reg).length], ['enablers', 'Enablers', S.reg.enablers.length], ['learning', 'Learning', S.reg.learning.length], ['triage', 'To sort', S.reg.triage.length]];
    if (UI.review && FAC()) tabs.push(['review', 'Review changes', UI.review.changes.length]);
    return '<div class="seg regtabs" id="regTabs">' + tabs.map(function (t) {
      return '<button aria-pressed="' + (UI.regTab === t[0]) + '" data-tab="' + t[0] + '"' + (t[0] === 'triage' && t[2] ? ' class="attn"' : '') + '>' + t[1] + ' <span class="tabn">' + t[2] + '</span></button>';
    }).join('') + '</div>';
  }
  function regSummary() {
    var s = REG.summary(S.reg);
    var cell = function (n, k, tip) { return '<div class="rsum__c"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><b>' + n + '</b><span>' + k + '</span></div>'; };
    var proposed = S.reg.opportunities.filter(function (o) { return o.origin === 'Proposed' && !o.confirmed; }).length;
    var needQ = S.reg.opportunities.filter(function (o) { return o.status !== 'Parked' && REG.needsQualification(o); }).length;
    return '<div class="rsum">' + cell(s.counted, 'workflows counted', 'Recurring workflows with an owner, a trigger and a time cost. Parked and unconfirmed Proposed ones are not counted.') +
      cell(s.blocked, 'blocked', 'An open Dependency, or a linked Enabler that is still open. Never set by hand: it clears when the blocker is done.') +
      cell(needQ, 'need qualification', 'Missing an owner, a trigger or a time per round. Each gap is an Open question under the workflow.') +
      cell(S.reg.items.filter(function (i) { return !i.auto; }).length, 'details attached', 'Build steps, guardrails, dependencies, setup actions and questions, each under its workflow.') +
      (proposed ? cell(proposed, 'proposed, to confirm', 'From the second viewpoint. They count once the client confirms them.') : '') + '</div>';
  }
  function vOpportunities() {
    var tab = UI.regTab;
    if (tab === 'review' && !UI.review) tab = UI.regTab = 'opps';
    var html = head('Register', 'Each card is one recurring workflow. What the room says about it sits underneath, by type. Blocked and Needs qualification are worked out, never typed in.',
      (MODE.role === 'participant' ? '<span class="chip chip--dots" id="dotsLeft" data-tip="Votes you still have to spend. One dot is one vote. Press plus on a workflow to spend one, minus to take it back." data-who="room">' + dotsLeft() + ' of ' + maxDots() + ' votes left</span><button class="btn btn--primary" data-action="newidea" data-tip="Add an idea of your own. It lands on the register for everyone with your name on it." data-who="room">Add an idea</button>' : '') +
      '<button class="btn fac" data-action="newop">Add workflow</button>' +
      '<button class="btn fac" data-action="consolidate" data-tip="Claude reads the whole register and proposes how it should look: duplicates merged, steps moved under their workflow, limits lifted into Enablers. Nothing changes until you tick each change and apply it." data-who="you"' + (RUN.consolidating ? ' disabled' : '') + '>' + (RUN.consolidating ? 'Consolidating…' : 'Consolidate session') + '</button>' +
      '<button class="btn part-hide' + (MODE.role === 'participant' ? '' : ' btn--primary') + '" data-action="export">Export Excel</button>' +
      '<button class="btn btn--ghost btn--sm fac" data-action="exportjson">JSON</button><button class="btn btn--ghost btn--sm fac" data-action="importjson">Import</button>');
    if (FAC()) REG.warnings(S.reg).forEach(function (w) { html += '<div class="rwarn fac"><b>' + (w.code === 'too_many' ? 'Too many workflows.' : 'Too flat.') + '</b> ' + esc(w.message) + '</div>'; });
    html += regSummary() + regTabs();
    if (tab === 'enablers') return html + vEnablers();
    if (tab === 'learning') return html + vLearning();
    if (tab === 'triage') return html + vTriage();
    if (tab === 'review') return html + vReview();
    html += voteControls();
    html += '<div class="toolbar"><div class="seg" id="fnFilter">' + ['All'].concat(CFG.functionsTags).map(function (f) { return '<button aria-pressed="' + (UI.filter.fn === f) + '" data-f="' + f + '">' + f + '</button>'; }).join('') + '</div>' +
      '<select id="stFilter">' + ['All', 'Blocked', 'Needs qualification', 'Proposed'].concat(REG.STATUSES).map(function (s) { return '<option' + (UI.filter.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<input type="search" id="qFilter" placeholder="Search workflows and their detail" value="' + esc(UI.filter.q) + '">' +
      '<button class="btn btn--sm btn--ghost" data-action="expandall">' + (UI.allOpen ? 'Fold all' : 'Unfold all') + '</button></div>';
    var ops = filteredOps();
    if (!S.reg.opportunities.length) return html + '<div class="empty"><b>Nothing on the register yet.</b><br>Start a transcript source in Live capture, or add a workflow by hand. Each recurring workflow gets a number; detail lands underneath it.</div>';
    html += '<p class="muted small">' + ops.length + ' of ' + S.reg.opportunities.length + ' shown</p>';
    return html + '<div class="rops">' + ops.map(regCard).join('') + '</div>';
  }
  function unitLine(o) {
    var f = function (k, label) { return o[k] ? '<span><span class="k">' + label + '</span> ' + esc(o[k]) + '</span>' : '<span class="miss">' + label + ' not known</span>'; };
    return '<div class="unit">' + f('owner', 'Owner') + f('frequency', 'Trigger') + f('timeBand', 'Each round') + '</div>';
  }
  function statusPills(o) {
    var st = oppStatus(o), blocked = st !== 'Parked' && REG.isBlocked(S.reg, o.id);
    return (blocked ? chip('chip--blocked', 'Blocked') : chip('chip--rst-' + st.replace(/\s/g, ''), st)) +
      (st !== 'Parked' && REG.needsQualification(o) ? chip('chip--needq', 'Needs qualification') : '') +
      (o.origin === 'Proposed' ? chip(o.confirmed ? 'chip--src-Consultant' : 'chip--proposed', o.confirmed ? 'Proposed, confirmed' : 'Proposed, not counted yet') : '');
  }
  function regCard(o) {
    var kids = REG.childrenOf(S.reg, o.id), real = kids.filter(function (i) { return !i.auto; });
    var open = UI.allOpen || UI.open[o.id];
    var b = REG.blockers(S.reg, o.id);
    var fo = flatOf(o);
    var counts = REG.CHILD_TYPES.filter(function (t) { return real.some(function (i) { return i.type === t; }); }).map(function (t) {
      var n = real.filter(function (i) { return i.type === t; }).length; return n + ' ' + (n === 1 ? REG.TYPE_LABELS[t].toLowerCase() : TYPE_PLURAL[t].toLowerCase());
    });
    var html = '<div class="rop' + (o.status === 'Parked' ? ' rop--parked' : '') + (REG.isBlocked(S.reg, o.id) && o.status !== 'Parked' ? ' rop--blocked' : '') + '" data-op="' + esc(o.id) + '">' +
      '<div class="op__id">' + esc(o.id) + '</div><div class="rop__main">' +
      '<div class="op__title"' + (FAC() ? ' contenteditable="true" spellcheck="false" data-field="title"' : '') + '>' + esc(o.title) + '</div>' +
      '<div class="op__meta">' + statusPills(o) + chip('chip--fn-' + o.fn, o.fn) + chip('', o.phase) + '</div>' + unitLine(o) +
      (o.problem ? '<p class="op__pain">' + esc(o.problem) + '</p>' : '') +
      (o.claudeDoes ? '<p class="op__dir"><b>Claude:</b> ' + esc(o.claudeDoes) + '</p>' : '') +
      (b.enablers.length || b.dependencies.length ? '<p class="rblock"><b>Blocked by</b> ' + b.enablers.map(function (e) { return '<button class="linkbtn" data-action="gotoenabler" data-id="' + esc(e.id) + '">' + esc(e.id) + '</button> ' + esc(cut(e.text, 90)); }).concat(b.dependencies.map(function (d) { return esc(d.id) + ' ' + esc(cut(d.text, 90)); })).join('; ') + '</p>' : '') +
      '<button class="kids__toggle" data-action="togglekids" data-id="' + esc(o.id) + '" aria-expanded="' + !!open + '">' + (real.length ? real.length + ' detail' + (real.length === 1 ? '' : 's') + ': ' + counts.join(', ') : 'No detail yet') + (o.evidence && o.evidence.length ? ' · ' + o.evidence.length + ' quote' + (o.evidence.length === 1 ? '' : 's') : '') + '</button>';
    if (open) html += kidsHtml(o, kids);
    html += '</div><div class="op__side">' + voteBox(fo) +
      (FAC() ? '<div class="stack"><button class="btn btn--sm btn--ghost" data-action="edit" data-id="' + esc(o.id) + '">Edit</button><button class="btn btn--sm btn--ghost" data-action="addkid" data-id="' + esc(o.id) + '">Add detail</button><button class="btn btn--sm btn--ghost" data-action="oppmove" data-id="' + esc(o.id) + '">Merge, fold or park</button>' +
        (o.origin === 'Proposed' && !o.confirmed ? '<button class="btn btn--sm" data-action="confirmopp" data-id="' + esc(o.id) + '" data-tip="The client agrees this is a real workflow. It then counts in the totals." data-who="you">Client confirms</button>' : '') + '</div>' : '') +
      (MODE.role === 'participant' && canEdit(fo) ? '<div class="row"><button class="btn btn--sm btn--ghost" data-action="editidea" data-id="' + esc(o.id) + '">Edit or delete</button></div>' : '') + '</div></div>';
    return html;
  }
  function cut(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function kidsHtml(o, kids) {
    var html = '<div class="kids">';
    REG.CHILD_TYPES.forEach(function (t) {
      var list = kids.filter(function (i) { return i.type === t; }); if (!list.length) return;
      html += '<div class="kids__group"><div class="kids__h kids__h--' + t + '">' + TYPE_PLURAL[t] + '</div><ul>' + list.map(function (i) {
        var extra = i.type === 'dependency' && i.owner ? ' <span class="muted small">Owner: ' + esc(i.owner) + '</span>' : i.type === 'open_question' && i.answerBy ? ' <span class="muted small">Answer by: ' + esc(i.answerBy) + '</span>' : '';
        return '<li class="kid' + (i.status === 'Done' ? ' kid--done' : '') + '" data-item="' + esc(i.id) + '"><span class="kid__id">' + esc(i.id) + '</span><span class="kid__t">' + esc(i.text) + extra +
          (i.evidence && i.evidence.length ? ' <span class="muted small" data-tip="' + esc(i.evidence.map(function (e) { return '“' + e.quote + '”' + (e.speaker ? ' ' + e.speaker : ''); }).join('\n')) + '">' + i.evidence.length + ' quote' + (i.evidence.length === 1 ? '' : 's') + '</span>' : '') + '</span>' +
          (FAC() ? '<span class="kid__acts">' + (i.auto ? '' : '<button class="btn btn--xs btn--ghost" data-action="kiddone" data-id="' + esc(i.id) + '">' + (i.status === 'Done' ? 'Reopen' : 'Done') + '</button><button class="btn btn--xs btn--ghost" data-action="editkid" data-id="' + esc(i.id) + '">Edit</button>') + '</span>' : '') + '</li>';
      }).join('') + '</ul></div>';
    });
    if (o.evidence && o.evidence.length) html += '<div class="kids__group"><div class="kids__h">What was said</div><ul>' + o.evidence.slice(0, 6).map(function (e) { return '<li class="kid"><span class="kid__t op__quote">“' + esc(e.quote) + '”' + (e.speaker ? ' · ' + esc(e.speaker) : '') + '</span></li>'; }).join('') + '</ul></div>';
    if (o.notes) html += '<div class="kids__group"><div class="kids__h">Notes</div><p class="small" style="white-space:pre-line">' + esc(o.notes) + '</p></div>';
    return html + '</div>';
  }
  function oppOptions(selected, skip) {
    return S.reg.opportunities.filter(function (o) { return o.id !== skip; }).map(function (o) { return '<option value="' + esc(o.id) + '"' + (o.id === selected ? ' selected' : '') + '>' + esc(o.id + ' ' + cut(o.title, 60)) + '</option>'; }).join('');
  }
  function vEnablers() {
    var html = '<p class="lede muted">Organisation-wide limits that block more than one workflow, and who owns clearing each one. Mark one Done and every workflow it blocked is unblocked.</p>' +
      (FAC() ? '<div class="row"><button class="btn btn--sm fac" data-action="newenabler">Add enabler</button></div>' : '');
    if (!S.reg.enablers.length) return html + '<div class="empty">No Enablers yet. Claude lifts a limit here when the room says it blocks two or more workflows.</div>';
    return html + '<div class="grid grid--2">' + S.reg.enablers.map(function (e) {
      return '<div class="card enb' + (e.status === 'Done' ? ' enb--done' : '') + '" id="enb-' + esc(e.id) + '"><div class="row spread"><div class="op__id">' + esc(e.id) + '</div><div class="op__meta" style="margin:0">' + chip(e.status === 'Done' ? 'chip--done' : 'chip--blocked', e.status === 'Done' ? 'Done' : 'Open') + chip('', e.owner) + '</div></div>' +
        '<p>' + esc(e.text) + '</p><div class="op__meta">Blocks ' + (e.links.length ? e.links.map(function (l) { var o = findRegOpp(l); return chip('', l + (o ? ' ' + cut(o.title, 40) : '')); }).join('') : '<span class="muted small">nothing linked</span>') + '</div>' +
        (FAC() ? '<div class="row"><button class="btn btn--sm" data-action="enablerdone" data-id="' + esc(e.id) + '">' + (e.status === 'Done' ? 'Reopen' : 'Mark done') + '</button><button class="btn btn--sm btn--ghost" data-action="editenabler" data-id="' + esc(e.id) + '">Edit</button></div>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function vLearning() {
    var html = '<p class="lede muted">Ways of working and training points the room raised. They shape the Foundations sessions and are never counted as workflows.</p>';
    if (!S.reg.learning.length) return html + '<div class="empty">No learning points yet.</div>';
    var by = {}; S.reg.learning.forEach(function (l) { var m = l.module || 'No module yet'; (by[m] = by[m] || []).push(l); });
    return html + '<div class="grid grid--2">' + Object.keys(by).sort().map(function (m) {
      return '<div class="card"><h3>' + esc(m) + '</h3><ul class="llist">' + by[m].map(function (l) {
        return '<li><span class="kid__id">' + esc(l.id) + '</span> <span' + (FAC() ? ' contenteditable="true" data-lfield="text" data-lid="' + esc(l.id) + '"' : '') + '>' + esc(l.text) + '</span>' +
          (FAC() ? ' <button class="btn btn--xs btn--ghost" data-action="dellearning" data-id="' + esc(l.id) + '">Remove</button>' : '') + '</li>';
      }).join('') + '</ul></div>';
    }).join('') + '</div>';
  }
  function vTriage() {
    var html = '<p class="lede muted">Things Claude heard but was not sure where to put. They are not on the register until someone places them.</p>';
    if (!S.reg.triage.length) return html + '<div class="empty"><b>Nothing to sort.</b> Everything Claude heard has a place.</div>';
    var types = [['build_step', 'Build step'], ['guardrail', 'Guardrail'], ['dependency', 'Dependency'], ['setup_action', 'Setup action'], ['open_question', 'Open question'], ['opportunity', 'New workflow'], ['enabler', 'Enabler'], ['learning', 'Learning']];
    return html + '<div class="stack">' + S.reg.triage.map(function (t) {
      var ev0 = (t.evidence || [])[0];
      return '<div class="card tri" data-tri="' + esc(t.id) + '"><div class="row spread"><div><span class="op__id">' + esc(t.id) + '</span> <b>' + esc(t.text) + '</b></div><span class="muted small">' + esc(t.reason) + '</span></div>' +
        (ev0 ? '<p class="op__quote">“' + esc(ev0.quote) + '”' + (ev0.speaker ? ' · ' + esc(ev0.speaker) : '') + '</p>' : '') +
        (FAC() ? '<div class="row tri__place"><label class="field">It is a<select id="tt-' + esc(t.id) + '">' + types.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === t.suggestedType ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label>' +
          '<label class="field">Under<select id="tp-' + esc(t.id) + '"><option value="">(no workflow)</option>' + oppOptions(REG.resolve(S.reg, t.suggestedParent || '')) + '</select></label>' +
          '<button class="btn btn--sm btn--primary" data-action="placetriage" data-id="' + esc(t.id) + '">Place it</button><button class="btn btn--sm btn--ghost btn--danger" data-action="droptriage" data-id="' + esc(t.id) + '">Not needed</button></div>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function vReview() {
    var R0 = UI.review, ticked = R0.changes.filter(function (c) { return R0.decisions[c.id]; }).length;
    var html = '<div class="card stack"><h3>' + R0.changes.length + ' changes proposed</h3><p class="muted small">Nothing has changed yet. Tick each change you agree with, then apply. A change that needs another one (a step going under a new workflow) is skipped if that one is not ticked.' +
      (R0.unplaced.length ? ' Claude did not place ' + R0.unplaced.length + ' row' + (R0.unplaced.length === 1 ? '' : 's') + ': ' + esc(R0.unplaced.join(', ')) + '. They stay as they are.' : '') + '</p>' +
      '<div class="row"><button class="btn btn--primary" data-action="applyreview"' + (ticked ? '' : ' disabled') + '>Apply ' + ticked + ' ticked</button><button class="btn btn--sm" data-action="tickall">Tick all</button><button class="btn btn--sm btn--ghost" data-action="untickall">Untick all</button><button class="btn btn--sm btn--ghost btn--danger" data-action="discardreview">Discard</button></div></div>';
    var KIND = { create: 'New workflow', retitle: 'Rename', qualify: 'Fill gaps', merge: 'Merge', demote: 'Fold in', promote: 'Own workflow', move: 'Move', reclassify: 'Change type', attach: 'Place', learning: 'To learning', triage: 'To sort', enabler: 'Enabler', link: 'Link' };
    html += '<div class="table-wrap"><table class="reg review"><thead><tr><th></th><th>Change</th><th>Before</th><th>After</th><th>Why</th></tr></thead><tbody>' + R0.changes.map(function (c) {
      var d = REG.describe(R0.base, c);
      return '<tr><td><input type="checkbox" data-review="' + esc(c.id) + '"' + (R0.decisions[c.id] ? ' checked' : '') + ' aria-label="Apply ' + esc(c.id) + '"></td><td><b>' + esc(KIND[c.kind] || c.kind) + '</b>' + (c.requires && c.requires.length ? '<div class="muted small">needs ' + esc(c.requires.join(', ')) + '</div>' : '') + '</td><td>' + esc(d.before) + '</td><td>' + esc(d.after) + '</td><td class="muted small">' + esc(c.reason || '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
    return html;
  }

  /* Consolidation: Claude proposes, a person approves each change. */
  function consolidateNow() {
    if (RUN.consolidating) return;
    if (!aiAvailable()) { toast('AI is off. Add a key in Settings, or set ANTHROPIC_API_KEY on the server.'); return; }
    var rows = PIPE.registerRows(S.reg).length;
    if (rows < 3) { toast('Not enough on the register to consolidate yet'); return; }
    if (serverAI() && rows > 90 && !confirm('The register has ' + rows + ' rows. Consolidating that many can take longer than the server allows (5 minutes) and be cut off. Run it anyway? For a large old export, the migration script is the safer route.')) return;
    RUN.consolidating = true; render();
    var base = REG.clone(S.reg), got = 0;
    setAiStatus('busy', 'Claude is consolidating ' + rows + ' rows…');
    template('consolidate').then(function (tpl) {
      return PIPE.consolidate(base, tpl, function (prompt) {
        return askJSON(prompt, 'consolidate', function (key) { if (key === 'placements') { got++; if (got % 10 === 0) setAiStatus('busy', 'Consolidating… ' + got + ' of ' + rows + ' rows placed'); } });
      }, { context: contextBlock() });
    }).then(function (res) {
      UI.review = { base: base, changes: res.changes, decisions: {}, unplaced: res.unplaced };
      UI.regTab = 'review';
      aiDone('Consolidation', [res.changes.length + ' changes to review']);
    }).catch(function (e) {
      log('Consolidation error: ' + (e && (e.code + ' ' + e.message)));
      setAiStatus('bad', 'Consolidation failed, see Live');
      toast('Consolidation failed: ' + String((e && e.message) || e).slice(0, 140));
    }).then(function () { RUN.consolidating = false; if (UI.view === 'opportunities') render(); });
  }
  function applyReview() {
    var R0 = UI.review; if (!R0) return;
    if (JSON.stringify(REG.clone(S.reg).opportunities.map(function (o) { return o.id; })) !== JSON.stringify(R0.base.opportunities.map(function (o) { return o.id; })) &&
      !confirm('The register has changed since Claude read it. Changes that no longer fit are skipped. Apply the ticked ones anyway?')) return;
    var before = REG.clone(S.reg);
    var out = REG.applyChanges(S.reg, R0.changes, R0.decisions, { by: SBA() ? (SB.myName() || 'facilitator') : 'facilitator' });
    S.reg = out.register;
    commit(before);
    var t = {}; out.results.forEach(function (r) { t[r.status] = (t[r.status] || 0) + 1; });
    UI.review = null; UI.regTab = 'opps';
    toast('Applied ' + (t.applied || 0) + (t.skipped ? ', skipped ' + t.skipped : '') + (t.failed ? ', failed ' + t.failed : '') + (t.rejected ? ', left out ' + t.rejected : ''));
    render();
  }
  function placeTriage(id) {
    var type = ($('#tt-' + id) || {}).value, parent = ($('#tp-' + id) || {}).value;
    if (REG.CHILD_TYPES.indexOf(type) >= 0 && !parent) { toast('Pick the workflow it belongs under'); return; }
    change(function (reg) {
      var t = reg.triage.filter(function (x) { return x.id === id; })[0]; if (!t) throw new Error(id + ' is already placed');
      var ev = t.evidence || [], newId;
      if (type === 'opportunity') newId = REG.createOpportunity(reg, Object.assign({}, t.capture || {}, { title: (t.capture && t.capture.title) || t.text, evidence: ev }), { createdBy: 'manual' }).id;
      else if (type === 'learning') { newId = nextFree(reg, 'L'); reg.learning.push({ id: newId, text: t.text, module: (t.capture && t.capture.module) || '', evidence: ev }); }
      else if (type === 'enabler') newId = REG.createEnabler(reg, { text: t.text, owner: (t.capture && t.capture.enablerOwner) || 'Client', links: parent ? [parent] : [], evidence: ev }, { createdBy: 'manual' }).id;
      else newId = REG.createChild(reg, parent, { type: type, text: t.text, evidence: ev }, { createdBy: 'manual' }).id;
      reg.triage = reg.triage.filter(function (x) { return x.id !== id; });
      reg.aliases[id] = newId;
      reg.log.push({ at: new Date().toISOString(), action: 'place', by: 'facilitator', detail: { from: id, to: newId } });
      toast(id + ' is now ' + newId);
    });
  }
  function nextFree(reg, prefix) {
    var ids = [].concat(reg.learning.map(function (x) { return x.id; }), reg.enablers.map(function (x) { return x.id; }), reg.triage.map(function (x) { return x.id; }), Object.keys(reg.aliases || {}));
    var m = 0; ids.forEach(function (x) { var r = new RegExp('^' + prefix + '(\\d+)$').exec(x || ''); if (r) m = Math.max(m, +r[1]); });
    return prefix + (m + 1);
  }

  /* The two things a facilitator reaches for mid-session: wipe the votes so
     the room can vote again on a shorter list, and hand everyone more votes.
     Both sit on the board itself, not three clicks away in Settings. */
  function voteControls() {
    if (MODE.role === 'participant') return '';
    var total = S.opportunities.reduce(function (n, o) { return n + (o.votes || 0); }, 0);
    var voted = S.opportunities.filter(function (o) { return (o.votes || 0) > 0; }).length;
    return '<div class="votebar part-hide">' +
      '<span class="votebar__k">Voting</span>' +
      '<span class="muted small">' + total + ' vote' + (total === 1 ? '' : 's') + ' cast across ' + voted + ' workflow' + (voted === 1 ? '' : 's') + '</span>' +
      (SBA() ? '<label class="votebar__dots">Votes each <input id="roomDots" type="number" min="1" value="' + esc(String(maxDots())) + '"></label>' +
        '<button class="btn btn--sm" data-action="savedots" data-who="you">Save</button>' : '') +
      '<button class="btn btn--sm btn--ghost btn--danger" data-action="resetvotes" data-who="you">Reset votes</button>' +
      '</div>';
  }
  function resetVotes() {
    var total = S.opportunities.reduce(function (n, o) { return n + (o.votes || 0); }, 0);
    if (!total) { toast('No votes to clear'); return; }
    if (!confirm('Clear all ' + total + ' vote' + (total === 1 ? '' : 's') + ' on this board? The ideas stay. Everyone can vote again straight away. This cannot be undone.')) return;
    if (SBA()) {
      SB.resetVotes().then(function (n) { if (n !== null) toast('Votes cleared. The room can vote again.'); });
      return;
    }
    S.reg.opportunities.forEach(function (o) { o.votes = 0; o.myDots = 0; });
    syncOps(); save(); render(); toast('Votes cleared. The room can vote again.');
  }
  function maxDots() { return (SBA() && SB.ws && SB.ws.max_dots) || 3; }
  function dotsLeft() { var used = 0; S.opportunities.forEach(function (o) { used += o.myDots || 0; }); return Math.max(0, maxDots() - used); }
  function voteBox(o) {
    if (MODE.role === 'participant') {
      var mine = o.myDots || 0;
      return '<div class="vote"><button data-action="vote" data-id="' + o.id + '" data-d="-1" aria-label="Take a vote back"' + (mine ? '' : ' disabled') + '>−</button><span class="vote__n" data-tip="' + o.votes + ' vote' + (o.votes === 1 ? '' : 's') + ' from the room, ' + mine + ' of them yours. One dot is one vote." data-who="room">' + o.votes + '</span><button data-action="vote" data-id="' + o.id + '" data-d="1" aria-label="Add a vote"' + (dotsLeft() ? '' : ' disabled') + '>+</button></div>' + (mine ? '<span class="small muted">your votes: ' + mine + '</span>' : '');
    }
    if (MODE.role === 'facilitator') {
      var who = (o.voters && o.voters.length) ? 'Voted: ' + o.voters.join(', ') : 'No votes yet';
      return '<div class="vote"><span class="vote__n vote__n--big" data-tip="' + esc(who) + '" data-who="room">' + o.votes + '</span><span class="small muted">votes</span></div>';
    }
    return '<div class="vote"><button data-action="vote" data-id="' + o.id + '" data-d="-1" aria-label="Remove a vote">−</button><span class="vote__n">' + o.votes + '</span><button data-action="vote" data-id="' + o.id + '" data-d="1" aria-label="Add a vote">+</button></div>';
  }
  function vSecond() {
    if (!S.revealed) {
      return '<div class="locked"><h2>The second viewpoint</h2><p>Sealed until the second viewpoint block. ' + (CFG.blindSpots.length ? 'What we saw from outside, and for each one, why we think it did not come up.' : 'Claude reads this workshop\'s transcript and board and writes the opportunities this room did not raise, each with a line on why it did not come up. Nothing is carried over from another workshop.') + '</p>' +
        '<div class="row fac" style="justify-content:center;margin-top:24px"><button class="btn btn--primary" data-action="reveal">Reveal</button><span class="muted small">' + (aiAvailable() ? 'Also asks Claude for blind spots from today’s transcript.' : 'AI is off, so this reveals the consultant list only.') + '</span></div></div>';
    }
    var raisedOps = S.opportunities.filter(function (o) { return o.status !== 'Parked' && o.origin !== 'Proposed'; });
    var raised = raisedOps.length;
    var byFn = {}; raisedOps.forEach(function (o) { byFn[o.fn] = (byFn[o.fn] || 0) + 1; });
    var ideas = CFG.blindSpots.concat(S.secondAI.map(function (i) { return Object.assign({}, i, { fromAI: true }); }));
    var html = '';
    html += '<section class="reveal" data-sc-act="pin" data-sc-span="2.6"><div class="sc-stage">' +
      '<div class="reveal__copy" data-sc-cue="-0.3 0.34"><div class="reveal__eyebrow">In the last 90 minutes</div><div class="reveal__n">' + raised + '</div><div class="reveal__k">ideas came from this room</div>' +
      '<div class="reveal__chips">' + CFG.functionsTags.map(function (f) { return byFn[f] ? chip('chip--fn-' + f, byFn[f] + ' ' + f) : ''; }).join('') + '</div></div>' +
      '<div class="reveal__copy" data-sc-cue="0.38 0.68"><div class="reveal__eyebrow">Now the second viewpoint</div><h2 data-sc-kinetic="lines">Here is what we saw<br>that you did not say.</h2></div>' +
      '<div class="reveal__copy" data-sc-cue="0.72 1"><div class="reveal__pair"><div><div class="reveal__k">Raised by you</div><div class="reveal__n">' + raised + '</div></div><div><div class="reveal__k">Seen from outside</div><div class="reveal__n" data-sc-count="0 ' + ideas.length + '" data-sc-count-at="0.74 0.92">0</div></div></div>' +
      '<p class="reveal__lede">Every idea below carries one line: why it did not come up. Keep scrolling to read them.</p></div>' +
      '<div class="reveal__hint" aria-hidden="true"><span>Scroll down</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div>' +
      '</div></section>';
    html += '<div class="view__head" style="margin-top:var(--sc-6)"><div><h1>The second viewpoint</h1><p>' + (CFG.blindSpots.length ? CFG.blindSpots.length + ' prepared before today' + (S.secondAI.length ? ', ' + S.secondAI.length + ' written by Claude from the transcript' : '') : (S.secondAI.length ? S.secondAI.length + ' written by Claude from today\'s transcript, none carried in from elsewhere' : 'Nothing here yet: Claude writes this list from today\'s transcript when there is enough of it (a few hundred characters). Press "Ask Claude again" once the transcript has grown.')) + '. New workflows from Claude are already on the register as Proposed; they count once the client confirms them.</p></div>' +
      '<div class="row fac"><button class="btn btn--ghost btn--sm" data-action="regen">Ask Claude again</button><button class="btn btn--ghost btn--sm" data-action="reseal">Re-seal</button></div></div>';
    html += '<div class="grid grid--2" data-sc-in data-sc-stagger="70">';
    ideas.forEach(function (i) {
      html += '<div class="card idea' + (promotedAs(i) ? ' idea--added' : '') + '"><div><div class="op__meta" style="margin:0 0 8px">' + chip('chip--fn-' + (i.fn || 'Both'), i.fn || 'Both') + chip('', i.surface) + chip('', i.build) + chip(i.fromAI ? 'chip--src-AI' : 'chip--src-Consultant', i.fromAI ? 'Claude, today' : 'Consultant') + chip('', i.confidence + ' confidence') + '</div><h3>' + esc(i.title) + '</h3></div>' +
        '<div class="idea__row"><span class="k">What</span><span>' + esc(i.what) + '</span></div>' +
        '<div class="idea__why"><b>Why you did not raise it:</b> ' + esc(i.why) + '</div>' +
        (i.lift ? '<div class="idea__row"><span class="k">Lift</span><span>' + esc(i.lift) + '</span></div>' : '') +
        (i.comparator ? '<div class="idea__row"><span class="k">Seen at</span><span>' + esc(i.comparator) + '</span></div>' : '') +
        ideaFoot(i) + '</div>';
    });
    html += '</div>';
    return html;
  }

  /* Prompts and skills. One card per idea: the interview that gets the detail
     out of the owner, the artefact itself, and the first message to send. */
  function vPrompts() {
    var map = packs();
    var ops = packCandidates();
    var withPack = ops.filter(function (o) { return map[o.id]; });
    var without = ops.filter(function (o) { return !map[o.id]; });
    var busy = !!RUN.packing;
    var html = head('Prompts and skills',
      'For every idea the room landed on: a prompt that interviews the owner, the skill or scheduled task itself, and the first message to send. Written by Claude from this board.',
      '<button class="btn btn--primary part-hide" data-action="genprompts"' + (busy ? ' disabled' : '') + '>' +
        (busy ? 'Writing ' + RUN.packing.done + ' of ' + RUN.packing.total + '…' : without.length ? 'Generate for ' + without.length + ' idea' + (without.length === 1 ? '' : 's') : 'Write them again') + '</button>' +
      (withPack.length ? '<button class="btn part-hide" data-action="genpromptsall"' + (busy ? ' disabled' : '') + ' data-who="you">Redo all</button>' : '') +
      '<button class="btn btn--ghost btn--sm part-hide" data-action="export">Export Excel</button>');

    if (!ops.length) return html + '<div class="empty"><b>Nothing to write for yet.</b><br>Prompts are written from the ideas on the board. Capture a few first, then come back.</div>';
    if (!withPack.length && !busy) {
      return html + '<div class="empty"><b>' + ops.length + ' idea' + (ops.length === 1 ? '' : 's') + ' ready.</b><br>' +
        'Press Generate. Claude reads each one and writes the interview prompt, the skill or scheduled task, and the first message to send. It takes a minute or two.' +
        (aiAvailable() ? '' : '<br><br><b>AI is off.</b> Add an Anthropic key in Settings, or set ANTHROPIC_API_KEY on the server.') + '</div>';
    }
    html += '<div class="packs">' + withPack.map(function (o) { return packCard(o, map[o.id]); }).join('') + '</div>';
    if (without.length) html += '<p class="muted small" style="margin-top:var(--sc-4)">' + without.length + ' idea' + (without.length === 1 ? ' has' : 's have') + ' no pack yet: ' + without.map(function (o) { return esc(o.id); }).join(', ') + '.</p>';
    return html;
  }
  function packCard(o, pk) {
    var parts = [
      ['interview', 'Interview prompt', 'Paste this into Claude. It interviews the person who owns the work and pulls out what the board never captured.', pk.interview],
      ['artefact', (pk.kind || o.build) + ': ' + (pk.artefactName || 'the artefact'), 'The thing itself, ready to paste.', pk.artefact],
      ['firstRun', 'First message', 'What to send once it exists.', pk.firstRun]
    ].filter(function (x) { return x[3]; });
    return '<div class="pack" data-op="' + esc(o.id) + '">' +
      '<div class="pack__head"><div><div class="op__id">' + esc(o.id) + '</div><h3>' + esc(o.title) + '</h3>' +
        '<div class="op__meta">' + chip('chip--fn-' + o.fn, o.fn) + chip('', pk.kind || o.build) + chip('chip--status-' + o.status, o.status) + chip('', o.votes + ' vote' + (o.votes === 1 ? '' : 's')) +
        ((pk.connectors || []).length ? chip('', 'Needs: ' + pk.connectors.join(', ')) : '') + '</div></div>' +
        '<button class="btn btn--sm btn--ghost part-hide" data-action="genprompt" data-id="' + esc(o.id) + '" data-who="you">Rewrite</button></div>' +
      (pk.watchOut ? '<p class="pack__watch"><b>Watch out:</b> ' + esc(pk.watchOut) + '</p>' : '') +
      parts.map(function (x) {
        return '<details class="pack__part"' + (x[0] === 'interview' ? ' open' : '') + '><summary>' + esc(x[1]) + '<span class="muted small"> ' + esc(x[2]) + '</span></summary>' +
          '<div class="pack__actions"><button class="btn btn--sm" data-action="copypack" data-id="' + esc(o.id) + '" data-part="' + x[0] + '">Copy</button></div>' +
          '<pre class="pack__text" id="pack-' + esc(o.id) + '-' + x[0] + '">' + esc(x[3]) + '</pre></details>';
      }).join('') + '</div>';
  }

  /* Once an idea is on the board the button is replaced, not just disabled:
     the room needs to see which of these were taken, and when. Everyone sees
     this, unlike the button, which is the facilitator's. */
  function ideaFoot(i) {
    var on = i.opp ? findOp(REG.resolve(S.reg, i.opp)) : null;
    if (!on) on = promotedAs(i);
    if (!on) return '<div class="row fac"><button class="btn btn--sm" data-action="promote" data-id="' + esc(i.id) + '">Put it on the register</button></div>';
    if (on.origin === 'Proposed' && !on.confirmed) {
      return '<div class="idea__added"><span class="chip chip--proposed">On the register as ' + esc(on.id) + ', not counted yet</span>' +
        '<button class="btn btn--sm fac" data-action="confirmopp" data-id="' + esc(on.id) + '">Client confirms</button></div>';
    }
    var when = addedWhen(on.createdAt);
    return '<div class="idea__added"><span class="chip chip--added">On the register as ' + esc(on.id) + '</span>' +
      (when ? '<span class="small muted">' + esc(when) + '</span>' : '') + '</div>';
  }

  function vLive() {
    var src = RUN.source;
    var html = head('Live capture', 'Facilitator only. Feed the transcript in. Claude reads it in windows and files each thing it hears: detail goes under its workflow, a new workflow gets a number, anything unclear goes to To sort.', '');
    html += '<div class="tiles" style="margin-bottom:var(--sc-4)">' +
      '<div class="tile"><div class="n" id="tChars">0</div><div class="k">chars captured</div></div>' +
      '<div class="tile"><div class="n" id="tPending">0</div><div class="k">unread by AI</div></div>' +
      '<div class="tile"><div class="n" id="tOps">0</div><div class="k">workflows counted</div></div>' +
      '<div class="tile"><div class="n" id="tAI">0</div><div class="k">heard by AI</div></div>' +
      '<div class="tile"><div class="n">' + S.reg.triage.length + '</div><div class="k">to sort</div></div></div>';
    html += '<div class="live"><div class="card stack"><div class="row spread"><h3>Sources</h3>' + (src !== 'none' ? '<button class="btn btn--sm btn--danger" data-action="stopsrc">Stop</button>' : '') + '</div>' +
      '<div class="mode">' +
      '<button data-action="src-mic" aria-pressed="' + (src === 'mic') + '">Browser mic<small>Chrome speech recognition. Free, rough, live.</small></button>' +
      '<button data-action="src-wispr" aria-pressed="' + (src === 'wispr') + '"' + (CAP.mcp ? '' : ' disabled') + '>Wispr Flow meeting<small>' + (CAP.mcp ? 'Polls the meeting recorder transcript via the connector.' : 'Needs the Artifact build with the Wispr Flow connector.') + '</small></button>' +
      '<button data-action="src-feed" aria-pressed="' + (src === 'feed') + '">JSON feed URL<small>A Claude Code or Cowork session writes ideas to a file; this polls it.</small></button>' +
      (CFG.demoTranscript && CFG.demoTranscript.length ? '<button data-action="src-demo" aria-pressed="' + (src === 'demo') + '">Demo transcript<small>Eight voices, one every nine seconds. Test the loop.</small></button>' : '') + '</div>' +
      '<label class="field">Paste the transcript here (the whole thing each time is fine: only the new part is added). Wispr Flow dictation works here too. Ctrl or Cmd + Enter to add.<textarea id="manualBox" placeholder="Paste from the live notes, or dictate…"></textarea></label>' +
      '<div class="row"><button class="btn" data-action="addmanual">Add to transcript</button><button class="btn btn--primary" data-action="extract">Read now</button><label class="check"><input type="checkbox" id="autoExtract"' + (S.settings.autoExtract ? ' checked' : '') + '> Auto-read every ' + S.settings.pollSec + 's</label></div>' +
      '<div class="log" id="liveLog"></div></div>' +
      '<div class="card stack"><div class="row spread"><h3>Transcript</h3><button class="btn btn--sm btn--ghost" data-action="cleartranscript">Clear</button></div><div class="feed" id="feed">' + S.transcript.map(function (c) { return feedItem(c, false); }).join('') + '</div></div></div>';
    return html;
  }
  function updateTiles() {
    var all = fullTranscript().length;
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    set('#tChars', all); set('#tPending', Math.max(0, all - S.consumedChars)); set('#tOps', REG.countedOpportunities(S.reg).length); set('#tAI', S.reg.opportunities.filter(function (o) { return o.createdBy === 'live'; }).length + S.reg.items.filter(function (i) { return i.createdBy === 'live' && !i.auto; }).length);
  }

  function vSettings() {
    var s = S.settings;
    var html = head('Settings', 'Kept in this browser only. The API key never syncs.', '');
    html += '<div class="settings">';
    if (window.SB && SB.user) html += settingsAccount();
    html += '<div class="card"><h3>How this page is running</h3><div class="kv">' +
      '<span class="k">Mode</span><span>' + (SBA() ? 'Connected to the shared backend as ' + esc(SB.role) : (window.SB && SB.user) ? 'Signed in. No workshop open yet: create or open one below.' : isArtifact() ? 'Published Artifact on claude.ai' : 'Standalone page, this browser only') + '</span>' +
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
      var io = id ? findOp(id) : { title: '', fn: CFG.functionsTags[0], pain: '', direction: '' }; if (!io) return;
      title.textContent = id ? 'Edit your idea' : 'Add an idea';
      body.innerHTML = '<label class="field">What is the task or the pain? One line.<input id="f_title" value="' + esc(io.title) + '" placeholder="Chasing invoice approvals every week"></label>' +
        '<label class="field">Whose is it?<select id="f_fn">' + CFG.functionsTags.map(function (x) { return '<option' + (x === io.fn ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field">Tell us a bit more (optional)<textarea id="f_pain" placeholder="How often, how long, what goes wrong">' + esc(io.pain) + '</textarea></label>' +
        '<label class="field">What would you want Claude to do? (optional)<textarea id="f_direction">' + esc(io.direction) + '</textarea></label>';
      $('#sheetDelete').hidden = !id;
    } else if (kind === 'phase') {
      var ph = id ? CFG.phases.filter(function (x) { return x.id === id; })[0] : { id: '', fn: CFG.functionsTags[0], name: '', what: '', prompts: [] };
      if (!ph) return;
      title.textContent = id ? 'Edit phase' : 'New phase';
      body.innerHTML = '<label class="field">Phase name<input id="f_name" value="' + esc(ph.name) + '" placeholder="Month-end close"></label>' +
        '<label class="field">Team<select id="f_fn">' + CFG.functionsTags.map(function (x) { return '<option' + (x === ph.fn ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field">What happens in it (one line, the room sees this)<input id="f_what" value="' + esc(ph.what || '') + '"></label>' +
        '<label class="field">Questions to ask (one per line, facilitator only)<textarea id="f_prompts">' + esc((ph.prompts || []).join('\n')) + '</textarea></label>';
      $('#sheetDelete').hidden = !id;
    } else if (kind === 'op') {
      var o = id ? findRegOpp(id) : { id: '', title: '', fn: CFG.functionsTags[0] || 'Both', phase: CFG.phases[0] ? CFG.phases[0].name : '', owner: '', frequency: '', timeBand: '', status: 'Identified', surface: '', systems: [], problem: '', claudeDoes: '', notes: '', value: null, ease: null, origin: 'Client-raised', confirmed: true };
      if (!o) return;
      title.textContent = id ? 'Edit ' + id : 'New workflow';
      var opt = function (list, v) { return list.map(function (x) { return '<option' + (x === v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join(''); };
      var ease = id ? REG.suggestEase(S.reg, o) : null;
      body.innerHTML = '<label class="field">Workflow (verb plus object)<input id="f_title" value="' + esc(o.title) + '" placeholder="Reconcile supplier statements monthly"></label>' +
        '<p class="muted small">The unit test: a real workflow has an owner, a trigger and a time per round. Leave one blank and it shows as Needs qualification, with an Open question for the gap.</p>' +
        '<div class="field-row"><label class="field">Owner<input id="f_owner" value="' + esc(o.owner) + '" placeholder="AP officer"></label><label class="field">Trigger or how often<input id="f_frequency" value="' + esc(o.frequency) + '" placeholder="Daily, 8am"></label>' +
        '<label class="field">Time each round<select id="f_timeBand"><option value="">Not known</option>' + opt(REG.TIME_BANDS, o.timeBand) + '</select></label></div>' +
        '<div class="field-row"><label class="field">Function<select id="f_fn">' + opt(CFG.functionsTags, o.fn) + '</select></label><label class="field">Status<select id="f_status">' + opt(REG.STATUSES, oppStatus(o)) + '</select></label></div>' +
        (CFG.phases.length ? '<label class="field">Process phase<select id="f_phase">' + opt(CFG.phases.map(function (p) { return p.name; }).concat(o.phase && !CFG.phases.some(function (p) { return p.name === o.phase; }) ? [o.phase] : []), o.phase) + '</select></label>'
          : '<label class="field">Process phase<input id="f_phase" value="' + esc(o.phase) + '"></label>') +
        '<div class="field-row"><label class="field">Claude surface<select id="f_surface"><option value=""></option>' + opt(CFG.surfaces.map(function (s) { return s.key; }), o.surface) + '</select></label><label class="field">Systems (comma separated)<input id="f_systems" value="' + esc((o.systems || []).join(', ')) + '"></label></div>' +
        '<label class="field">Problem, in their words<textarea id="f_problem">' + esc(o.problem) + '</textarea></label>' +
        '<label class="field">What Claude does (input and output)<textarea id="f_claudeDoes">' + esc(o.claudeDoes) + '</textarea></label>' +
        '<div class="field-row"><label class="field">Value (client, 1 to 5)<input id="f_value" type="number" min="1" max="5" value="' + esc(o.value == null ? '' : o.value) + '"></label><label class="field">Ease (consultant, 1 to 5)<input id="f_ease" type="number" min="1" max="5" value="' + esc(o.ease == null ? '' : o.ease) + '"></label></div>' +
        (ease ? '<p class="muted small">Suggested ease ' + ease.ease + ': ' + esc(ease.reason) + '.</p>' : '') +
        (o.origin === 'Proposed' ? '<label class="check"><input type="checkbox" id="f_confirmed"' + (o.confirmed ? ' checked' : '') + '> The client has confirmed this Proposed workflow, so it counts</label>' : '') +
        '<label class="field">Notes<textarea id="f_notes">' + esc(o.notes) + '</textarea></label>';
      $('#sheetDelete').hidden = !id;
    } else if (kind === 'kid' || kind === 'addkid') {
      var k = kind === 'kid' ? REG.findItem(S.reg, id) : { id: '', parentId: id, type: 'build_step', text: '', owner: '', answerBy: '', status: 'Open' };
      if (!k) return;
      title.textContent = kind === 'kid' ? 'Edit ' + k.id : 'Add detail to ' + id;
      body.innerHTML = '<label class="field">What it is<select id="f_type">' + REG.CHILD_TYPES.map(function (t) { return '<option value="' + t + '"' + (t === k.type ? ' selected' : '') + '>' + REG.TYPE_LABELS[t] + '</option>'; }).join('') + '</select></label>' +
        '<label class="field">Text<textarea id="f_text" placeholder="Never overwrite the supplier\'s own reference">' + esc(k.text) + '</textarea></label>' +
        '<div class="field-row"><label class="field">Owner (dependency) or who answers (question)<input id="f_owner" value="' + esc(k.owner || k.answerBy || '') + '"></label>' +
        '<label class="field">Under workflow<select id="f_parent">' + oppOptions(k.parentId) + '</select></label></div>' +
        (kind === 'kid' ? '<div class="row"><button class="btn btn--sm" data-action="promotekid" data-id="' + esc(k.id) + '" data-tip="This is a recurring workflow in its own right. It gets its own number; the old number points to it." data-who="you">Make it a workflow</button>' +
          '<button class="btn btn--sm btn--ghost" data-action="kidtolearning" data-id="' + esc(k.id) + '">It is a learning point</button></div>' : '');
      $('#sheetDelete').hidden = kind !== 'kid';
    } else if (kind === 'oppmove') {
      var mo = findRegOpp(id); if (!mo) return;
      title.textContent = 'Merge, fold or park ' + id;
      body.innerHTML = '<p class="muted small">' + esc(mo.title) + '</p>' +
        '<label class="field">What to do<select id="f_move"><option value="merge">It is the same workflow as another: merge it in</option><option value="fold">It is a step of another workflow: fold it in</option><option value="park">Park it (kept, not counted)</option>' + (mo.status === 'Parked' ? '<option value="unpark">Bring it back from Parked</option>' : '') + '</select></label>' +
        '<label class="field">Into workflow<select id="f_into">' + oppOptions('', mo.id) + '</select></label>' +
        '<label class="field">Folded in as<select id="f_as">' + REG.CHILD_TYPES.map(function (t) { return '<option value="' + t + '">' + REG.TYPE_LABELS[t] + '</option>'; }).join('') + '</select></label>' +
        '<p class="muted small">Merge keeps the evidence, the detail, the Enabler links and the votes. Fold turns it into one line under the other workflow and moves its detail with it. Either way the old number still finds it.</p>';
      $('#sheetDelete').hidden = true;
    } else if (kind === 'enabler') {
      var en = id ? REG.findEnabler(S.reg, id) : { id: '', text: '', owner: 'Client', status: 'Open', links: [] };
      if (!en) return;
      title.textContent = id ? 'Edit ' + id : 'New enabler';
      body.innerHTML = '<label class="field">The limit, and what clears it<textarea id="f_text">' + esc(en.text) + '</textarea></label>' +
        '<label class="field">Who clears it<select id="f_owner">' + REG.ENABLER_OWNERS.map(function (x) { return '<option' + (x === en.owner ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label>' +
        '<div class="field"><span>Workflows it blocks</span><div class="checks">' + S.reg.opportunities.map(function (o) { return '<label class="check"><input type="checkbox" data-link="' + esc(o.id) + '"' + (en.links.indexOf(o.id) >= 0 ? ' checked' : '') + '> ' + esc(o.id + ' ' + cut(o.title, 50)) + '</label>'; }).join('') + '</div></div>';
      $('#sheetDelete').hidden = !id;
    } else {
      var s = id ? S.systems.filter(function (x) { return x.id === id; })[0] : { id: '', name: '', category: '', usedBy: '', connector: '', status: 'assumed', note: '' };
      if (!s) return;
      title.textContent = id ? 'Edit system' : 'Add a system';
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
      if (SHEET.id) { var mine = findOp(SHEET.id); if (mine) { Object.assign(mine, { title: v('f_title'), fn: v('f_fn'), pain: v('f_pain'), direction: v('f_direction') }); pushOp(mine, ['title', 'fn', 'pain', 'direction']); } closeSheet(); render(); toast('Saved'); return; }
      var name = (window.SB && SB.myName && SB.myName()) || (SB.user && SB.user.email && SB.user.email.split('@')[0]) || 'Participant';
      addOpportunity({ title: v('f_title'), function: v('f_fn'), pain: v('f_pain'), direction: v('f_direction'), raisedBy: name, phase: '', surface: 'Claude Chat', build: 'Skill', confidence: 'Medium' }, 'Participant');
      closeSheet(); toast('On the board'); return;
    }
    if (SHEET.kind === 'op') {
      var num = function (id) { var n = parseInt(v(id), 10); return n >= 1 && n <= 5 ? n : null; };
      var data = { title: v('f_title'), fn: v('f_fn'), status: v('f_status'), phase: v('f_phase'), owner: v('f_owner'), frequency: v('f_frequency'), timeBand: v('f_timeBand'),
        surface: v('f_surface'), systems: v('f_systems').split(',').map(function (x) { return x.trim(); }).filter(Boolean), problem: v('f_problem'), claudeDoes: v('f_claudeDoes'),
        value: num('f_value'), ease: num('f_ease'), notes: v('f_notes') };
      if (!data.title) { toast('A title is needed'); return; }
      if (SHEET.id) {
        var cb = $('#f_confirmed');
        change(function (reg) { var o = REG.findOpp(reg, SHEET.id); Object.assign(o, data); if (cb) o.confirmed = cb.checked; REG.syncQualification(reg, o, { createdBy: 'manual' }); });
      } else {
        change(function (reg) { var o = REG.createOpportunity(reg, data, { createdBy: 'manual' }); o.source = 'Room'; });
      }
      closeSheet(); render(); return;
    } else if (SHEET.kind === 'kid' || SHEET.kind === 'addkid') {
      var kd = { type: v('f_type'), text: v('f_text'), owner: v('f_owner'), parent: v('f_parent') };
      if (!kd.text) { toast('Say what it is'); return; }
      change(function (reg) {
        if (SHEET.kind === 'addkid') {
          var made = REG.createChild(reg, kd.parent || SHEET.id, { type: kd.type, text: kd.text, owner: kd.owner, answerBy: kd.owner }, { createdBy: 'manual' });
          UI.open[made.parentId] = true; return;
        }
        var k = REG.findItem(reg, SHEET.id); if (!k) throw new Error(SHEET.id + ' is gone');
        k.text = kd.text;
        if (kd.type !== k.type) k = REG.reclassify(reg, k.id, kd.type, { by: 'facilitator' });
        if (k.type === 'dependency') k.owner = kd.owner; else if (k.type === 'open_question') k.answerBy = kd.owner;
        if (kd.parent && kd.parent !== k.parentId) REG.moveChild(reg, k.id, kd.parent, { by: 'facilitator' });
      });
      closeSheet(); render(); return;
    } else if (SHEET.kind === 'oppmove') {
      var mv = v('f_move'), into = v('f_into'), as = v('f_as');
      change(function (reg) {
        if (mv === 'park' || mv === 'unpark') { REG.findOpp(reg, SHEET.id).status = mv === 'park' ? 'Parked' : 'Identified'; return; }
        if (!into) throw new Error('Pick the workflow to put it into');
        if (mv === 'merge') REG.mergeOpportunities(reg, SHEET.id, into, { by: 'facilitator' });
        else REG.demote(reg, SHEET.id, into, as, { by: 'facilitator' });
        UI.open[into] = true;
      });
      closeSheet(); render(); return;
    } else if (SHEET.kind === 'enabler') {
      var et = v('f_text'), eo = v('f_owner'), links = $$('[data-link]').filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.link; });
      if (!et) { toast('Say what the limit is'); return; }
      change(function (reg) {
        if (!SHEET.id) { REG.createEnabler(reg, { text: et, owner: eo, links: links }, { createdBy: 'manual' }); return; }
        var e = REG.findEnabler(reg, SHEET.id); e.text = et; e.owner = eo; e.links = links.slice();
      });
      closeSheet(); render(); return;
    } else if (SHEET.kind === 'phase') {
      var pd = { name: v('f_name'), fn: v('f_fn'), what: v('f_what'), prompts: v('f_prompts').split('\n').map(function (x) { return x.trim(); }).filter(Boolean) };
      if (!pd.name) { toast('A name is needed'); return; }
      if (SHEET.id) { var cur = CFG.phases.filter(function (x) { return x.id === SHEET.id; })[0]; if (cur) { var oldName = cur.name; Object.assign(cur, pd); if (oldName !== pd.name) S.opportunities.forEach(function (o) { if (o.phase === oldName) { o.phase = pd.name; pushOp(o, ['phase']); } }); if (SBA() && cur.uid) SB.updatePhase(cur.uid, pd).catch(function () {}); } }
      else if (SBA()) SB.insertPhase(pd).catch(function () {});
      else CFG.phases.push(Object.assign({ id: 'p' + uid() }, pd));
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
    if (SHEET.kind === 'phase') { if (!confirm('Remove this phase? Ideas on it keep their phase name and show under "Not yet placed".')) return; var dph = CFG.phases.filter(function (x) { return x.id === SHEET.id; })[0]; if (dph && SBA() && dph.uid) SB.deletePhase(dph.uid).catch(function () {}); CFG.phases = CFG.phases.filter(function (x) { return x.id !== SHEET.id; }); }
    else if (SHEET.kind === 'idea') { if (!confirm('Delete your idea? It leaves the board for everyone.')) return; var dmine = findOp(SHEET.id); if (dmine && SBA() && dmine.uid) SB.deleteOpportunity(dmine.uid).catch(function () {}); S.opportunities = S.opportunities.filter(function (o) { return o.id !== SHEET.id; }); }
    else if (SHEET.kind === 'op') {
      if (!confirm('Delete ' + SHEET.id + ' and everything under it? Consider Park instead; a deleted workflow leaves no trace.')) return;
      change(function (reg) {
        var id = SHEET.id;
        reg.items = reg.items.filter(function (i) { return i.parentId !== id; });
        reg.enablers.forEach(function (e) { e.links = e.links.filter(function (l) { return l !== id; }); });
        reg.opportunities = reg.opportunities.filter(function (o) { return o.id !== id; });
      });
      closeSheet(); render(); return;
    }
    else if (SHEET.kind === 'kid') { if (!confirm('Delete ' + SHEET.id + '?')) return; change(function (reg) { reg.items = reg.items.filter(function (i) { return i.id !== SHEET.id; }); }); closeSheet(); render(); return; }
    else if (SHEET.kind === 'enabler') { if (!confirm('Delete ' + SHEET.id + '? The workflows it blocked are unblocked.')) return; change(function (reg) { reg.enablers = reg.enablers.filter(function (e) { return e.id !== SHEET.id; }); }); closeSheet(); render(); return; }
    else { var dsys = S.systems.filter(function (x) { return x.id === SHEET.id; })[0]; if (dsys && SBA() && dsys.uid) SB.deleteSystem(dsys.uid).catch(function () {}); S.systems = S.systems.filter(function (s) { return s.id !== SHEET.id; }); }
    save(); closeSheet(); render(); updateBadge();
  }

  /* ------------------------------------------------------------- export -- */
  function boardBundle() {
    return { client: CFG.client, teams: teamsSentence(), reg: S.reg, opportunities: S.opportunities,
      blindSpots: CFG.blindSpots || [], secondAI: S.secondAI || [], systems: S.systems, phases: CFG.phases || [], packs: packs() };
  }
  function bundleStem(B) { return String((B.client && (B.client.short || B.client.name)) || 'board').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'board'; }
  function exportXlsx(bundle) {
    var B = bundle || boardBundle();
    if (!window.XLSX) { exportCsv(B); return; }
    var wb = XLSX.utils.book_new();
    var G = B.reg || legacyToRegister(B.opportunities || []);
    var when = function (t) { return t ? new Date(t).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) : ''; };
    var quotes = function (x) { return (x.evidence || []).map(function (e) { return '"' + e.quote + '"' + (e.speaker ? ' ' + e.speaker : ''); }).join('\n'); };
    /* One row per workflow. ID and Opportunity keep their old column names,
       so an export can still be read back by the migration script. */
    var opsRows = G.opportunities.map(function (o) {
      var c = REG.childCounts(G, o.id), real = REG.childrenOf(G, o.id).filter(function (i) { return !i.auto; });
      var bl = REG.blockers(G, o.id);
      return { ID: o.id, Opportunity: o.title, Function: o.fn, 'Process phase': o.phase, Owner: o.owner, 'Trigger or frequency': o.frequency, 'Time per round': o.timeBand,
        Status: oppStatus(o), Blocked: o.status !== 'Parked' && REG.isBlocked(G, o.id) ? 'Yes' : '', 'Blocked by': bl.enablers.map(function (e) { return e.id; }).concat(bl.dependencies.map(function (d) { return d.id; })).join(', '),
        'Needs qualification': REG.needsQualification(o) ? 'Yes, missing ' + REG.missingUnitFields(o).map(function (f) { return { owner: 'owner', frequency: 'trigger', timeBand: 'time' }[f]; }).join(', ') : '',
        Origin: o.origin || 'Client-raised', Counted: REG.countedOpportunities(G).indexOf(o) >= 0 ? 'Yes' : 'No',
        'Claude surface': o.surface, 'Problem / pain': o.problem, 'What Claude does': o.claudeDoes, Systems: (o.systems || []).join(', '),
        'Build steps': c.build_step, Guardrails: c.guardrail, Dependencies: c.dependency, 'Setup actions': c.setup_action, 'Open questions': real.filter(function (i) { return i.type === 'open_question'; }).length,
        Votes: o.votes || 0, 'Value (client 1-5)': o.value == null ? '' : o.value, 'Ease (consultant 1-5)': o.ease == null ? '' : o.ease,
        'Source quote': quotes(o), Notes: o.notes || '', Captured: when(o.createdAt) };
    });
    var ws1 = XLSX.utils.json_to_sheet(opsRows.length ? opsRows : [{ ID: '', Opportunity: '' }]);
    ws1['!cols'] = [6, 44, 11, 24, 18, 20, 13, 11, 8, 14, 22, 13, 8, 16, 50, 60, 24, 7, 7, 7, 7, 7, 6, 8, 8, 50, 30, 18].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws1, 'Opportunity Register');
    var itemRows = G.items.slice().sort(function (a, b) { return a.parentId === b.parentId ? parseInt(a.id.split('.')[1], 10) - parseInt(b.id.split('.')[1], 10) : parseInt(a.parentId.slice(1), 10) - parseInt(b.parentId.slice(1), 10); }).map(function (i) {
      var p = REG.findOpp(G, i.parentId) || {};
      return { ID: i.id, Workflow: i.parentId + ' ' + (p.title || ''), Type: REG.TYPE_LABELS[i.type], Detail: i.text, Status: i.status, 'Owner or who answers': i.owner || i.answerBy || '',
        'Blocked by': i.blockedBy ? (i.blockedBy.kind + (i.blockedBy.ref ? ': ' + i.blockedBy.ref : '')) : '', 'Raised automatically': i.auto ? 'Yes, for the unit test' : '', Evidence: quotes(i) };
    });
    var wsI = XLSX.utils.json_to_sheet(itemRows.length ? itemRows : [{ ID: '', Detail: '' }]);
    wsI['!cols'] = [8, 44, 14, 70, 8, 20, 22, 18, 60].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, wsI, 'Workflow Detail');
    var wsE = XLSX.utils.json_to_sheet(G.enablers.length ? G.enablers.map(function (e) { return { ID: e.id, Enabler: e.text, 'Who clears it': e.owner, Status: e.status, Blocks: e.links.join(', '), Evidence: quotes(e) }; }) : [{ ID: '', Enabler: '' }]);
    wsE['!cols'] = [6, 80, 14, 8, 24, 60].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, wsE, 'Enablers');
    var wsL = XLSX.utils.json_to_sheet(G.learning.length ? G.learning.map(function (l) { return { ID: l.id, 'Learning point': l.text, Module: l.module, Evidence: quotes(l) }; }) : [{ ID: '', 'Learning point': '' }]);
    wsL['!cols'] = [6, 70, 24, 60].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, wsL, 'Learning Backlog');
    if (G.triage.length) {
      var wsT = XLSX.utils.json_to_sheet(G.triage.map(function (t) { return { ID: t.id, 'Heard': t.text, 'Claude thought it was': t.suggestedType, 'Under': t.suggestedParent, Why: t.reason, Evidence: quotes(t) }; }));
      wsT['!cols'] = [6, 70, 16, 10, 30, 60].map(function (w) { return { wch: w }; });
      XLSX.utils.book_append_sheet(wb, wsT, 'To Sort');
    }
    var ideas = B.blindSpots.concat(B.secondAI).map(function (i) { return { ID: i.id, Idea: i.title, Function: i.fn, 'Process phase': i.phase, 'Claude surface': i.surface, 'Build type': i.build, 'What it is': i.what, 'Why they did not raise it': i.why, 'How it lifts the north star': i.lift, Comparator: i.comparator, Confidence: i.confidence, Origin: i.id.charAt(0) === 'A' ? 'Claude, from the transcript' : 'Consultant, prepared' }; });
    var ws2 = XLSX.utils.json_to_sheet(ideas); ws2['!cols'] = [5, 44, 11, 28, 16, 16, 60, 60, 30, 30, 10, 22].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws2, 'New Ideas');
    var flat = G.opportunities.map(flatOf);
    var packRows = flat.filter(function (o) { return o.status !== 'Parked' && B.packs[o.id]; })
      .sort(function (a, b) { return (b.status === 'Qualified') - (a.status === 'Qualified') || (b.votes - a.votes); })
      .map(function (o) {
      var pk = B.packs[o.id];
      return { ID: o.id, Opportunity: o.title, Function: o.fn, 'Build type': pk.kind || o.build, 'Artefact name': pk.artefactName || '',
        Votes: o.votes, Status: o.status, Owner: o.owner,
        'Interview prompt (paste into Claude)': pk.interview || '', 'The artefact (skill, task or instructions)': pk.artefact || '',
        'First message to send': pk.firstRun || '', 'Connectors needed': (pk.connectors || []).join(', '), 'Watch out for': pk.watchOut || '' };
    });
    if (packRows.length) {
      var wsP = XLSX.utils.json_to_sheet(packRows);
      wsP['!cols'] = [6, 44, 11, 16, 26, 6, 11, 14, 90, 90, 60, 30, 60].map(function (w) { return { wch: w }; });
      XLSX.utils.book_append_sheet(wb, wsP, 'Prompts and Skills');
    }
    var ws3 = XLSX.utils.json_to_sheet(B.systems.map(function (s) { return { System: s.name, Category: s.category, 'Used by': s.usedBy, 'Claude reach': s.connector, Status: s.status, Note: s.note }; }));
    ws3['!cols'] = [18, 16, 20, 26, 10, 60].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws3, 'Systems');
    var ws4 = XLSX.utils.json_to_sheet(B.phases.map(function (p) { return { Phase: p.name, Function: p.fn, 'What happens': p.what, '# workflows': G.opportunities.filter(function (o) { return o.phase === p.name && o.status !== 'Parked'; }).length }; }));
    ws4['!cols'] = [34, 11, 70, 14].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws4, 'Lifecycle Map');
    var ws5 = XLSX.utils.aoa_to_sheet([['AI opportunity workshop: ' + B.client.name + ', ' + B.teams], ['Exported', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })], ['North star', B.client.northStar], ['Scope criterion', B.client.scopeCriterion], [], ['Tabs', 'Opportunity Register (one row per recurring workflow), Workflow Detail (build steps, guardrails, dependencies, setup actions and open questions under each), Enablers (organisation-wide limits and what they block), Learning Backlog' + (G.triage.length ? ', To Sort (heard but not yet placed)' : '') + ', New Ideas (the second viewpoint)' + (packRows.length ? ', Prompts and Skills (what to paste into Claude to build each one)' : '') + ', Systems, Lifecycle Map'],
      ['Counting', 'A workflow counts when it is not Parked and, if Proposed by the consultant or Claude, the client has confirmed it. Blocked means an open Dependency or a linked open Enabler; it clears itself.'], ['Scoring', 'Client owns Value; consultant owns Ease. Fill the two columns in the register, then build the 2x2 in the prioritisation session.']]);
    ws5['!cols'] = [{ wch: 18 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws5, 'Read Me');
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    var name = bundleStem(B) + '-AI-opportunities-' + new Date().toISOString().slice(0, 10) + '.xlsx';
    deliverFile(name, new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }
  function exportCsv(bundle) {
    var B = bundle || boardBundle();
    var cols = ['id', 'title', 'fn', 'phase', 'cluster', 'surface', 'build', 'status', 'pain', 'direction', 'systems', 'quote', 'raisedBy', 'owner', 'source', 'confidence', 'votes', 'notes'];
    var q = function (v) { v = Array.isArray(v) ? v.join('; ') : String(v == null ? '' : v); return '"' + v.replace(/"/g, '""') + '"'; };
    var list = B.reg ? B.reg.opportunities.map(flatOf) : B.opportunities;
    var lines = [cols.join(',')].concat(list.map(function (o) { return cols.map(function (c) { return q(o[c]); }).join(','); }));
    toast('Spreadsheet library missing, exporting CSV instead');
    deliverFile(bundleStem(B) + '-AI-opportunities-' + new Date().toISOString().slice(0, 10) + '.csv', new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
  }
  function deliverFile(name, blob) {
    if (CAP.downloads) { CAP.downloads.save({ filename: name, data: blob }).then(function () { toast('Saved ' + name); }).catch(function (e) { if (e && e.code !== 'declined') { log('download: ' + e.code); anchorDownload(name, blob); } }); return; }
    anchorDownload(name, blob);
  }
  function anchorDownload(name, blob) { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000); toast('Exported ' + name); }
  function fileStem() { return String((CFG.client && (CFG.client.short || CFG.client.name)) || 'board').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'board'; }
  function exportJson() { deliverFile(fileStem() + '-board-' + new Date().toISOString().slice(0, 10) + '.json', new Blob([JSON.stringify({ reg: S.reg, systems: S.systems, secondAI: S.secondAI, promptPacks: packs(), transcript: S.transcript }, null, 2)], { type: 'application/json' })); }
  function importJson() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = function () { var f = inp.files[0]; if (!f) return; f.text().then(function (t) {
        var j = JSON.parse(t), n = 0;
        if (j.reg && j.reg.opportunities) {
          if (!confirm('Replace the register with the one in this file (' + j.reg.opportunities.length + ' workflows)? The current register is overwritten.')) return;
          var before = REG.clone(S.reg);
          S.reg = Object.assign(REG.empty(), j.reg);
          LISTS.forEach(function (k) { (S.reg[k] || []).forEach(function (x) { delete x.uid; }); });
          fillUids(S.reg); commit(before); n = S.reg.opportunities.length;
        } else (j.opportunities || []).forEach(function (o) { if (addOpportunity(Object.assign({}, o, { 'function': o.fn || o['function'] }), o.source || 'Room')) n++; });
        if (j.systems && !SBA()) S.systems = j.systems;
        save(); render(); toast('Imported ' + n + ' workflows'); }).catch(function () { toast('That file did not parse'); }); };
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
    $('#sheetBody').addEventListener('click', function (e) { var b = e.target.closest('[data-action]'); if (b) handleAction(b.dataset.action, b, e); });
    $('#btnHelp').addEventListener('click', openHelp); $('#helpClose').addEventListener('click', closeHelp); $('#helpBackdrop').addEventListener('click', closeHelp);

    var view = $('#view');
    view.addEventListener('click', function (e) {
      var b = e.target.closest('[data-action]');
      if (b) { handleAction(b.dataset.action, b, e); return; }
      var nv = e.target.closest('[data-view]'); if (nv) { go(nv.dataset.view); return; }
      var seg;
      if ((seg = e.target.closest('#regTabs button'))) { UI.regTab = seg.dataset.tab; render(); return; }
      if ((seg = e.target.closest('#fnFilter button'))) { UI.filter.fn = seg.dataset.f; render(); return; }
      if ((seg = e.target.closest('#themeSeg button'))) { S.settings.theme = seg.dataset.t; applyTheme(); save(); render(); return; }
      if ((seg = e.target.closest('[data-sysstatus] button'))) { var sys = S.systems.filter(function (x) { return x.id === seg.parentNode.dataset.sysstatus; })[0]; if (sys) { sys.status = seg.dataset.st; save(); render(); pushSys(sys); } return; }
      var ph = e.target.closest('.phase'); if (ph && !e.target.closest('button,a')) { ph.classList.toggle('open'); return; }
      var blk = e.target.closest('.block'); if (blk && !e.target.closest('button')) { blk.classList.toggle('block--open'); }
    });
    view.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'stFilter') { UI.filter.status = t.value; render(); return; }
      if (t.dataset && t.dataset.review && UI.review) { UI.review.decisions[t.dataset.review] = t.checked; render(); return; }
      if (t.id === 'autoExtract') { S.settings.autoExtract = t.checked; save(); if (t.checked) scheduleExtract(); return; }
      if (t.id === 'wisprMeeting') { S.settings.wisprMeetingId = t.value; save(); return; }

    });
    view.addEventListener('input', function (e) { if (e.target.id === 'qFilter') { UI.filter.q = e.target.value; clearTimeout(UI.qT); UI.qT = setTimeout(function () { var v = $('#qFilter'); var pos = v.selectionStart; render(); var nv = $('#qFilter'); if (nv) { nv.focus(); nv.setSelectionRange(pos, pos); } }, 350); } });
    view.addEventListener('focusout', function (e) {
      var t = e.target; if (!t.dataset || !t.isContentEditable) return;
      var val = t.textContent.trim();
      if (t.dataset.lfield) {
        var lid = t.dataset.lid, ln = S.reg.learning.filter(function (x) { return x.id === lid; })[0];
        if (ln && val && val !== ln.text) change(function (reg) { reg.learning.filter(function (x) { return x.id === lid; })[0].text = val; });
      } else if (t.dataset.field === 'title') {
        var row = t.closest('[data-op]'), oid = row && row.dataset.op, o = oid && findRegOpp(oid);
        if (o && val && val !== o.title) change(function (reg) { REG.findOpp(reg, oid).title = val; });
      }
      if (UI.pendingRender) { UI.pendingRender = false; setTimeout(render, 50); }
    });
    view.addEventListener('keydown', function (e) {
      if (e.target.id === 'manualBox' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleAction('addmanual'); }
      if (e.target.isContentEditable && e.key === 'Enter' && !e.shiftKey && e.target.classList.contains('op__title')) { e.preventDefault(); e.target.blur(); }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeSheet(); closeHelp(); hideBigQr(); return; }
      if (e.target.matches('input,textarea,select,[contenteditable]') || $('#sheet').classList.contains('open') || $('#help').classList.contains('open')) return;
      var map = { '1': 'runsheet', '2': 'systems', '3': 'process', '4': 'opportunities', '5': 'second', '6': 'prompts', '7': 'live', '8': 'settings' };
      if (map[e.key]) { if ((UI.present || MODE.role === 'participant') && (e.key === '1' || e.key === '7' || e.key === '8')) return; go(map[e.key]); }
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
      case 'addkid': openSheet('addkid', b.dataset.id); break;
      case 'editkid': openSheet('kid', b.dataset.id); break;
      case 'oppmove': openSheet('oppmove', b.dataset.id); break;
      case 'newenabler': openSheet('enabler', null); break;
      case 'editenabler': openSheet('enabler', b.dataset.id); break;
      case 'togglekids': UI.open[b.dataset.id] = !UI.open[b.dataset.id]; render(); break;
      case 'expandall': UI.allOpen = !UI.allOpen; UI.open = {}; render(); break;
      case 'kiddone': change(function (reg) { var k = REG.findItem(reg, b.dataset.id); k.status = k.status === 'Done' ? 'Open' : 'Done'; }); render(); break;
      case 'confirmopp': change(function (reg) { REG.findOpp(reg, b.dataset.id).confirmed = true; }); toast(b.dataset.id + ' now counts'); render(); break;
      case 'enablerdone': change(function (reg) { var en = REG.findEnabler(reg, b.dataset.id); en.status = en.status === 'Done' ? 'Open' : 'Done'; }); render(); break;
      case 'gotoenabler': UI.regTab = 'enablers'; render(); var eel = $('#enb-' + b.dataset.id); if (eel) eel.scrollIntoView({ block: 'center' }); break;
      case 'dellearning': change(function (reg) { reg.learning = reg.learning.filter(function (l) { return l.id !== b.dataset.id; }); }); render(); break;
      case 'placetriage': placeTriage(b.dataset.id); render(); break;
      case 'droptriage': change(function (reg) { reg.triage = reg.triage.filter(function (x) { return x.id !== b.dataset.id; }); }); render(); break;
      case 'promotekid': closeSheet(); change(function (reg) { var no = REG.promote(reg, b.dataset.id, null, { by: 'facilitator' }); toast(b.dataset.id + ' is now workflow ' + no.id); }); render(); break;
      case 'kidtolearning': closeSheet(); change(function (reg) { var nl = REG.toLearning(reg, b.dataset.id, '', { by: 'facilitator' }); toast(b.dataset.id + ' is now learning point ' + nl.id); }); render(); break;
      case 'consolidate': consolidateNow(); break;
      case 'applyreview': applyReview(); break;
      case 'tickall': UI.review.changes.forEach(function (c) { UI.review.decisions[c.id] = true; }); render(); break;
      case 'untickall': UI.review.decisions = {}; render(); break;
      case 'discardreview': if (confirm('Discard all ' + UI.review.changes.length + ' proposed changes? The register stays as it is.')) { UI.review = null; UI.regTab = 'opps'; render(); } break;
      case 'vote': var op = findRegOpp(b.dataset.id); if (op) { if (SBA()) { if (op.uid) SB.vote(op.uid, parseInt(b.dataset.d, 10)); } else { op.votes = Math.max(0, (op.votes || 0) + parseInt(b.dataset.d, 10)); syncOps(); save(); render(); } } break;
      case 'newidea': openSheet('idea', null); break;
      case 'resetvotes': resetVotes(); break;
      case 'genprompts': generatePrompts(); break;
      case 'genpromptsall': if (confirm('Write every pack again from scratch? The ones on the board now are replaced.')) { savePacks({}).then(function () { render(); generatePrompts(); }); } break;
      case 'genprompt': var po = findOp(b.dataset.id); if (po) generatePrompts([po]); break;
      case 'copypack': var el = $('#pack-' + b.dataset.id + '-' + b.dataset.part); if (el) copyText(el.textContent); break;
      case 'export': exportXlsx(); break;
      case 'exportjson': exportJson(); break;
      case 'importjson': importJson(); break;
      case 'reveal': S.revealed = true; UI.seq++; save(); render(); updateBadge(); if (SBA()) SB.updateWorkshop({ revealed: true }).catch(function () {}); generateSecond().then(function () { UI.seq++; if (UI.view === 'second') render(); }); break;
      case 'regen': generateSecond().then(function () { UI.seq++; if (UI.view === 'second') render(); }); break;
      case 'reseal': S.revealed = false; save(); render(); updateBadge(); if (SBA()) SB.updateWorkshop({ revealed: false }).catch(function () {}); break;
      case 'copylink': copyText(joinLink()); break;
      case 'copylinkfor': copyText(joinLinkFor(b.dataset.slug, b.dataset.code)); break;
      case 'addphase': openSheet('phase', null); break;
      case 'editphase': openSheet('phase', b.dataset.id); break;
      case 'adoptphase': var np = { fn: CFG.functionsTags.indexOf(b.dataset.fn) >= 0 ? b.dataset.fn : CFG.functionsTags[0], name: b.dataset.name, what: '', prompts: [] }; if (SBA()) SB.insertPhase(np).catch(function () {}); else { CFG.phases.push(Object.assign({ id: 'p' + uid() }, np)); render(); } toast('Phase added'); break;
      case 'editidea': openSheet('idea', b.dataset.id); break;
      case 'savename': var nm = (($('#a_name') || {}).value || '').trim(); if (!nm) { toast('Type your name first'); return; } SB.setName(nm).then(function () { enterWorkshop({ ok: true }); }).catch(function () {}); break;
      case 'savedots': var dotsEl = b.closest('.votebar') ? $('#roomDots') : $('#setDots'); var nd = parseInt((dotsEl || {}).value, 10); if (!(nd >= 1)) { toast('Votes per person must be 1 or more'); return; } SB.updateWorkshop({ max_dots: nd }).then(function () { toast('Everyone now has ' + nd + ' vote' + (nd === 1 ? '' : 's')); }).catch(function () {}); break;
      case 'startblank': startBlank(); break;
      case 'bigqr': showBigQr(); break;
      case 'closeqr': hideBigQr(); break;
      case 'sendlink': authSendLink(); break;
      case 'joincode': authJoin(); break;
      case 'emaillogin': authScreen('login', SB.param('w'), 'email'); break;
      case 'signout': SB.signOut(); break;
      case 'openws': location.href = location.pathname + '?w=' + encodeURIComponent(b.dataset.slug); break;
      case 'delws': deleteWorkshop(b.dataset.id); break;
      case 'dupws': duplicateWorkshop(b.dataset.id); break;
      case 'createws': adminCreateWorkshop(); break;
      case 'showtoken': SB.bridgeToken().then(function (t) { var el = $('#bridgeToken'); if (el) el.textContent = t; }); break;
      case 'copytoken': SB.bridgeToken().then(copyText); break;
      case 'promote': var idea = CFG.blindSpots.concat(S.secondAI).filter(function (i) { return i.id === b.dataset.id; })[0]; if (idea) { var ok = addOpportunity({ title: idea.title, function: idea.fn, phase: idea.phase, surface: idea.surface, pain: '', direction: idea.what, systems: [], quote: '', raisedBy: idea.id.charAt(0) === 'A' ? 'Claude' : 'Consultant', notes: 'Why not raised: ' + idea.why, origin: 'Proposed', confirmed: true }, 'Consultant'); toast(ok ? 'On the register' : 'Already on the register, so its evidence was added there'); if (UI.view === 'second') render(); } break;
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
  /* The join link is the QR code as text: workshop plus code. Anyone who
     opens it types a name and is in. It is shown and copied wherever the
     code is already visible, so it exposes nothing the room cannot see. */
  function joinLinkFor(slug, code) { return location.origin + location.pathname + '?w=' + encodeURIComponent(slug || '') + '&code=' + encodeURIComponent(code || ''); }
  function startBlank() {
    if (!SBA() || SB.role !== 'facilitator') return;
    if (!confirm('Start this workshop blank? Removes every system, every process phase and every prepared second viewpoint idea from this workshop. Opportunities, votes and the transcript stay. This cannot be undone.')) return;
    var c = Object.assign({}, SB.ws.config || {}); delete c.phases; c.systems = []; c.blindSpots = [];
    SB.clearPrepared(c).then(function () { CFG.phases = []; CFG.blindSpots = []; S.systems = []; toast('Blank slate. Add systems and phases before the day.'); render(); }).catch(function () {});
  }
  /* The QR carries the join code too, so a scan lands straight on the name
     prompt. The code is on the same screen as the QR, so nothing is leaked. */
  function joinLink() { return joinLinkFor(SB.ws ? SB.ws.slug : '', SB.ws ? SB.ws.join_code : ''); }
  function qrSvg(text) {
    if (!window.qrcode) return '';
    try { var q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (e) { return ''; }
  }
  function showBigQr() {
    hideBigQr();
    var d = document.createElement('div'); d.className = 'qrbig'; d.id = 'qrbig';
    d.innerHTML = '<div class="qrbig__card"><div class="qrbig__qr">' + qrSvg(joinLink()) + '</div><div class="qrbig__side"><div class="k">Scan with your phone camera, or open the link</div><div class="qrbig__url">' + esc(joinLink()) + '</div><div class="k">Code</div><div class="joincard__code">' + esc(SB.ws ? SB.ws.join_code : '') + '</div><button class="btn" data-action="closeqr">Close</button></div></div>';
    d.addEventListener('click', function (e) { if (e.target === d) hideBigQr(); });
    document.body.appendChild(d);
  }
  function hideBigQr() { var d = $('#qrbig'); if (d) d.remove(); }
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
      var keepPhases = CFG.phases, keepBlind = CFG.blindSpots;
      CFG = Object.assign({}, SEED, BLANK, w.config || {});
      CFG.phases = p.phases ? [] : (keepPhases || []);
      CFG.blindSpots = p.second ? [] : (keepBlind || []);
      if (!CFG.client || !CFG.client.name) CFG.client = Object.assign({}, SEED.client, { name: w.title });
      brandLines();
      S.agendaIdx = typeof w.current_block === 'number' ? w.current_block : -1;
      S.timer = { running: !!w.timer_running, startedAt: w.block_started_at ? Date.parse(w.block_started_at) : now(), elapsedBefore: Number(w.timer_elapsed_ms || 0) };
      S.revealed = !!w.revealed; S.consumedChars = w.consumed_chars || 0;
    }
    if (p.systems) S.systems = p.systems.map(function (r) { return { id: r.id, uid: r.id, name: r.name, category: r.category || '', usedBy: r.used_by || '', connector: r.connector || '', status: r.status, note: r.note || '', source: r.source || 'Facilitator', addedBy: r.added_by || '', createdBy: r.created_by || null }; });
    if (p.phases) CFG.phases = p.phases.map(function (r) { return { id: r.id, uid: r.id, fn: r.fn || '', name: r.name, what: r.what || '', prompts: r.prompts || [], source: r.source || 'Facilitator', addedBy: r.added_by || '', createdBy: r.created_by || null }; });
    /* Votes and participants' ideas arrive as opportunity rows; the register
       is the source of truth, so any of them means read it again. */
    if (p.opportunities) reloadRegister();
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
    else if (kind === 'name') html += '<h2>What is your name?</h2><p class="muted">It goes next to your votes and ideas so the room knows who said what.</p><label class="field">Your name<input id="a_name" value="' + esc(j.name || '') + '" placeholder="Priya" autocomplete="given-name"></label><div class="row"><button class="btn btn--primary" data-action="savename">Continue</button></div>';
    else if (kind === 'rescan') html += '<h2>Scan the code on the screen</h2><p class="muted">This phone joined as a participant, but no workshop is in the link. Point your camera at the square on the facilitator’s screen to get back in.</p><div class="row"><button class="btn btn--ghost" data-action="signout">Start over</button></div>';
    else if (kind === 'login' && slug && extra !== 'email') html += '<h2>Join the workshop</h2><p class="muted">Your name is all we need. It goes next to your ideas and votes.</p>' +
      '<label class="field">Your name<input id="a_name" value="' + esc(j.name || '') + '" placeholder="Priya" autocomplete="given-name"></label>' +
      '<label class="field' + (code ? ' hidden' : '') + '">Join code (on the screen)<input id="a_code" value="' + esc(code) + '" autocapitalize="characters"></label>' +
      '<div class="row"><button class="btn btn--primary" data-action="joincode">Join</button></div><p class="small muted" id="a_msg"></p>' +
      '<p class="small muted">Facilitator? <button class="linkbtn" data-action="emaillogin">Sign in by email</button></p>';
    else html += '<h2>Sign in to the board</h2><p class="muted">No password. We email you a link.</p>' +
      '<label class="field">Your name<input id="a_name" value="' + esc(j.name || '') + '" placeholder="Priya"></label>' +
      '<label class="field">Work email<input id="a_email" type="email" placeholder="you@company.com" autocomplete="email"></label>' +
      (slug ? '<label class="field">Join code (on the screen)<input id="a_code" value="' + esc(code) + '"></label>' : '') +
      '<div class="row"><button class="btn btn--primary" data-action="sendlink">Email me a link</button></div><p class="small muted" id="a_msg"></p>';
    html += '</div>';
    $('#view').innerHTML = html;
    var f = $('#a_email') || ((kind === 'login' && slug) || kind === 'name' ? $('#a_name') : null) || $('#a_code'); if (f) f.focus();
  }
  function authSendLink() {
    var email = ($('#a_email') || {}).value || '', name = ($('#a_name') || {}).value || '', code = ($('#a_code') || {}).value || '';
    email = email.trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('That email does not look right'); return; }
    var slug = SB.param('w');
    $('#a_msg').textContent = 'Sending…';
    SB.sendLink(email, name.trim(), slug, code.trim()).then(function () { authScreen('sent', slug, email); }).catch(function (e) { $('#a_msg').textContent = 'Could not send: ' + (e.message || e); });
  }
  function authJoin() {
    var code = ($('#a_code') || {}).value || '', name = ($('#a_name') || {}).value || '', slug = SB.param('w');
    code = code.trim(); name = name.trim();
    if (!code) { toast('Enter the code'); return; }
    if (!name) { toast('Type your name first'); return; }
    authScreen('loading');
    var p = SB.user ? SB.joinWithCode(slug, code, name) : SB.joinAnonymously(slug, code, name);
    p.then(enterWorkshop).catch(function (e) {
      var m = (e && e.message) || 'Wrong code';
      if (/anonymous/i.test(m)) { authScreen('login', slug, 'email'); var el = $('#a_msg'); if (el) el.textContent = 'Quick join is switched off on the server (Supabase Auth: allow anonymous sign-ins). Use email for now.'; return; }
      toast(m); authScreen(SB.user ? 'join' : 'login', slug);
    });
  }
  function enterWorkshop(r) {
    if (r && r.error) { if (r.error === 'join') { authScreen('join', SB.param('w')); return; } toast(r.error); authScreen('join', SB.param('w')); return; }
    /* Every vote, idea, system and phase carries a name. Nobody gets in
       without one, on a phone or a laptop, even with an old session. */
    if (!SB.myName()) { authScreen('name', SB.param('w')); return; }
    document.body.classList.remove('auth');
    MODE.sb = true; MODE.role = SB.role;
    document.body.classList.toggle('participant', SB.role === 'participant');
    setModeStatus(); probeCapabilities(); reloadRegister();
    var start = SB.role === 'participant' ? 'opportunities' : (S.agendaIdx >= 0 && CFG.agenda[S.agendaIdx] ? CFG.agenda[S.agendaIdx].view : 'runsheet');
    go(start);
    var seen = false; try { seen = !!localStorage.getItem('wos.seen'); } catch (e) {}
    if (!seen && SB.role !== 'participant') openHelp();
  }
  function route() {
    var slug = SB.param('w');
    if (!SB.user) { authScreen('login', slug); return; }
    if (!slug && SB.isAnon()) { authScreen('rescan'); return; }
    if (!slug) { document.body.classList.remove('auth'); MODE.sb = true; MODE.role = 'facilitator'; setModeStatus(); go('settings'); return; }
    authScreen('loading', slug);
    SB.openWorkshop(slug).then(enterWorkshop).catch(function (e) { toast(e.message || 'Could not open'); authScreen('join', slug); });
  }
  function settingsAccount() {
    var w = SB.ws;
    var h = '<div class="card stack"><h3>Account</h3><div class="kv"><span class="k">Signed in</span><span>' + esc(SB.user.email || 'guest (no email)') + '</span><span class="k">Role</span><span>' + esc(SB.role || 'no workshop open') + '</span></div><div class="row"><button class="btn btn--ghost btn--sm" data-action="signout">Sign out</button></div></div>';
    if (w && SB.role === 'facilitator') {
      h += '<div class="card stack"><h3>This workshop: ' + esc(w.title) + '</h3>' +
        '<div class="kv"><span class="k">Join link</span><span><code>' + esc(joinLink()) + '</code> <button class="btn btn--sm" data-action="copylink" data-tip="The QR code as a link: send it by email or Teams to anyone joining from their desk. They open it, type a name and are in. Same code as on the screen.">Copy</button></span>' +
        '<span class="k">Join code</span><span><b>' + esc(w.join_code) + '</b> <span class="small muted">(inside the link; needed only if someone opens the bare site address)</span></span>' +
        '<span class="k">Votes per person</span><span><input id="setDots" type="number" min="1" value="' + esc(w.max_dots) + '" style="width:5em"> <button class="btn btn--sm" data-action="savedots" data-tip="How many votes each person gets. One dot is one vote. Any number; it applies to everyone as soon as you save.">Save</button></span>' +
        '<span class="k">Bridge token</span><span><code id="bridgeToken">hidden</code> <button class="btn btn--sm btn--ghost" data-action="showtoken" data-tip="Reveals the secret a Claude Code or Cowork session uses to post transcript and ideas into this workshop through /api/ingest. See docs/WISPR-BRIDGE.md.">Show</button> <button class="btn btn--sm btn--ghost" data-action="copytoken">Copy</button></span>' +
        '<span class="k">Workshop id</span><span><code>' + esc(w.id) + '</code></span>' +
        '<span class="k">Prepared content</span><span>' + S.systems.length + ' systems, ' + CFG.phases.length + ' phases, ' + CFG.blindSpots.length + ' prepared second viewpoint ideas <button class="btn btn--sm btn--ghost" data-action="startblank" data-tip="Wipes the systems, phases and prepared second viewpoint ideas from this workshop so it carries nothing from a template or another client. Opportunities, votes and transcript stay.">Start blank</button></span></div>' +
        '<div id="membersList" class="small muted">Loading members…</div></div>';
    }
    h += '<div class="card stack" id="adminCard"><h3>Workshops</h3><div id="wsList" class="small muted">Loading…</div>' +
      '<details><summary style="cursor:pointer;font-weight:700">New workshop</summary><div class="stack" style="margin-top:10px">' +
      '<div class="field-row"><label class="field">Organisation<select id="n_org"><option value="">New organisation…</option></select></label><label class="field">New organisation name<input id="n_orgname" placeholder="Client name"></label></div>' +
      '<div class="field-row"><label class="field">Workshop title<input id="n_title" placeholder="Operations ideation workshop"></label><label class="field">Business name shown on the board<input id="n_client" placeholder="The client\'s business name"></label></div>' +
      '<div class="field-row"><label class="field">Teams in the room (comma separated)<input id="n_fns" placeholder="Finance, Purchasing"></label><label class="field">Join code<input id="n_code" value="' + esc(String(Math.floor(1000 + Math.random() * 9000))) + '"></label><label class="field">Votes per person (one dot is one vote)<input id="n_dots" type="number" value="3" min="1"></label></div>' +
      '<label class="field">About the client (one line for Claude: industry, size, anything that frames the ideas)<input id="n_about" placeholder="Luxury watch and jewellery retailer, UK listed, 8 people in the room"></label>' +
      '<label class="field">North star<input id="n_north" value="' + esc(SEED.client.northStar) + '"></label><label class="field">Scope test<input id="n_scope" value="' + esc(SEED.client.scopeCriterion) + '"></label>' +
      '<p class="small muted">A new workshop is a blank slate: no systems, no process phases, no prepared second viewpoint ideas. Add systems and phases in the board before the day. The run sheet gets one process walk block per team. When it is created you land on the Run sheet with the QR code and the join link for this workshop.</p>' +
      '<div class="row"><button class="btn btn--primary" data-action="createws">Create workshop</button></div></div></details></div>';
    return h;
  }
  /* Rows behind the Workshops list, so Delete can say what it is about to
     destroy without going back to the database for it. */
  var WS_ROWS = {};
  function wsContents(st) {
    if (!st) return '<span class="muted">empty</span>';
    var bits = [];
    if (st.opps) bits.push(st.opps + ' idea' + (st.opps === 1 ? '' : 's'));
    if (st.votes) bits.push(st.votes + ' vote' + (st.votes === 1 ? '' : 's'));
    if (st.systems) bits.push(st.systems + ' system' + (st.systems === 1 ? '' : 's'));
    if (st.phases) bits.push(st.phases + ' phase' + (st.phases === 1 ? '' : 's'));
    if (st.transcript) bits.push('transcript');
    return bits.length ? esc(bits.join(' · ')) : '<span class="muted">empty</span>';
  }
  function whenUsed(iso) {
    var t = Date.parse(iso); if (!t) return '';
    var days = Math.floor((now() - t) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    return new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Melbourne' });
  }

  /* The Excel workbook for a workshop that is not open, so a backup can be
     taken without leaving Settings. */
  function exportWorkshopXlsx(id) {
    toast('Building the backup…');
    return Promise.all([SB.loadWorkshopData(id), SB.loadRegister(id)]).then(function (both) {
      var d = both[0]; if (!d) return false;
      var cfg = d.config || {}, client = cfg.client || { name: d.workshop.title };
      var teams = (client.functions || []).length ? client.functions.join(' and ') + (client.functions.length === 1 ? ' team' : ' teams') : 'the team';
      exportXlsx({ client: client, teams: teams, reg: both[1] || null, opportunities: d.opportunities, blindSpots: d.blindSpots,
        secondAI: d.secondAI, systems: d.systems, phases: d.phases, packs: cfg.promptPacks || {} });
      return true;
    }).catch(function (e) { toast('Could not build the backup: ' + (e.message || e)); return false; });
  }

  /* Duplicate a workshop as a template for the next client. */
  function duplicateWorkshop(id) {
    var row = WS_ROWS[id]; if (!row) return;
    var w = row.w;
    var title = prompt('Name for the copy', w.title.replace(/\s*\(copy\)$/, '') + ' (copy)');
    if (title === null) return;
    title = String(title).trim(); if (!title) { toast('Give it a name'); return; }
    var slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Math.random().toString(36).slice(2, 6);
    var code = String(Math.floor(1000 + Math.random() * 9000));
    toast('Copying…');
    SB.duplicateWorkshop(id, { slug: slug, title: title, joinCode: code }).then(function (r) {
      if (!r) return;
      var c = r.copied;
      toast('Copied: ' + c.systems + ' systems, ' + c.phases + ' phases, ' + c.ideas + ' prepared ideas. Join code ' + code + '.');
      fillAdmin();
      if (confirm('"' + title + '" is ready.\n\nIt has the systems, phases and prepared second viewpoint ideas, and none of the previous session\'s opportunities, votes or transcript.\n\nJoin code: ' + code + '\n\nOpen it now?')) {
        location.href = location.pathname + '?w=' + encodeURIComponent(slug);
      }
    }).catch(function () {});
  }

  /* Deleting a workshop takes the client's whole session with it, so the
     confirmation is proportionate to what is inside: an empty one goes on a
     single yes, one with real work in it offers a backup first and then makes
     you type its join code. */
  function deleteWorkshop(id) {
    var row = WS_ROWS[id]; if (!row) return;
    var w = row.w, st = row.stats;
    var real = st && (st.opps || st.transcript || st.votes);
    var what = st ? wsContents(st).replace(/<[^>]+>/g, '') : 'nothing';
    if (!real) {
      if (!confirm('Delete "' + w.title + '"?\n\nIt holds ' + what + '. This cannot be undone.')) return;
      finish();
      return;
    }
    if (!confirm('Delete "' + w.title + '"?\n\nThis permanently destroys ' + what + '.\n\nThere is no undo.')) return;
    var backup = confirm('Save an Excel backup of "' + w.title + '" first?\n\nOK downloads the workbook now.\nCancel skips it and goes straight to deleting.');
    (backup ? exportWorkshopXlsx(id) : Promise.resolve(true)).then(function (okBackup) {
      if (backup && !okBackup) { toast('Backup failed, so nothing was deleted.'); return; }
      if (backup && !confirm('Backup downloaded. Check it saved, then press OK to delete "' + w.title + '" for good.')) return;
      var typed = prompt('To confirm, type this workshop\'s join code: ' + w.join_code);
      if (typed === null) return;
      if (String(typed).trim() !== String(w.join_code).trim()) { toast('That did not match. Nothing was deleted.'); return; }
      finish();
    });

    function finish() {
      var wasOpen = SB.ws && SB.ws.id === id;
      SB.deleteWorkshop(id).then(function (ok) {
        if (!ok) return;
        toast('Deleted "' + w.title + '"');
        if (wasOpen) { location.href = location.pathname; return; }
        fillAdmin();
      });
    }
  }

  function fillAdmin() {
    if (!(window.SB && SB.user)) return;
    Promise.all([SB.listOrgs(), SB.listWorkshops(), SB.workshopStats().catch(function () { return {}; })]).then(function (r) {
      var orgs = r[0], wss = r[1], stats = r[2] || {}, sel = $('#n_org'), list = $('#wsList');
      WS_ROWS = {}; wss.forEach(function (w) { WS_ROWS[w.id] = { w: w, stats: stats[w.id] || null }; });
      if (sel) sel.innerHTML = '<option value="">New organisation…</option>' + orgs.map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.name) + '</option>'; }).join('');
      if (!list) return;
      if (!wss.length) { list.innerHTML = 'No workshops yet. Create one below.'; return; }
      var open = SB.ws ? SB.ws.id : null;
      list.innerHTML = '<table class="reg" style="min-width:0"><thead><tr><th>Workshop</th><th>Organisation</th><th>Code</th><th>What is in it</th><th>Last used</th><th></th></tr></thead><tbody>' +
        wss.map(function (w) {
          var o = orgs.filter(function (x) { return x.id === w.org_id; })[0];
          return '<tr' + (w.id === open ? ' class="ws--open"' : '') + '><td>' + esc(w.title) + (w.id === open ? ' <span class="chip">open now</span>' : '') + '</td>' +
            '<td>' + esc(o ? o.name : '') + '</td><td>' + esc(w.join_code) + '</td>' +
            '<td class="small">' + wsContents(stats[w.id]) + '</td>' +
            '<td class="small muted">' + esc(whenUsed(w.updated_at)) + '</td>' +
            '<td><div class="wsacts">' +
              '<button class="btn btn--sm btn--ghost" data-action="copylinkfor" data-slug="' + esc(w.slug) + '" data-code="' + esc(w.join_code) + '">Link</button>' +
              '<button class="btn btn--sm" data-action="openws" data-slug="' + esc(w.slug) + '">Open</button>' +
              '<button class="btn btn--sm btn--ghost" data-action="dupws" data-id="' + esc(w.id) + '">Copy</button>' +
              '<button class="btn btn--sm btn--ghost btn--danger" data-action="delws" data-id="' + esc(w.id) + '">Delete</button>' +
            '</div></td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="small muted">Opening a workshop picks it up exactly where it was left: every idea, vote, system, phase and the transcript. Nothing expires. Copy makes a fresh workshop from this one\'s systems, phases and prepared ideas, leaving the session\'s own work behind. Delete offers a backup first, then is permanent.</p>';
    }).catch(function (e) { log('admin: ' + (e.message || e)); });
    if (SB.ws && SB.role === 'facilitator') SB.members().then(function (ms) {
      var el = $('#membersList'); if (!el) return;
      el.innerHTML = '<b>' + ms.length + ' member' + (ms.length === 1 ? '' : 's') + '</b>: ' + ms.map(function (m) { return esc(m.display_name || m.email || '?') + ' (' + m.role + ')'; }).join(', ');
    });
  }
  /* A new workshop's config: the client's own words plus generic vocabulary.
     Nothing from data/seed.js that describes a particular client (systems,
     phases, blind spots, demo transcript) is copied. The run sheet is built
     from the teams named in the form. */
  function blankConfig(f) {
    var fns = (f.functions || []).filter(Boolean); if (!fns.length) fns = ['Team'];
    var tags = fns.slice(); if (fns.length > 1) tags.push('Both'); tags.push('Org-wide');
    var walkMins = 30, per = Math.max(5, Math.round(walkMins / fns.length));
    var agenda = [
      { id: 'a1', mins: 5, title: 'Frame the session', view: 'runsheet',
        say: 'We are here to find where Claude gives you hours back. Not to replace anyone. Every idea you raise lands on that board and you will see the count grow. At the end I will show you a second list: things we saw that you did not raise.',
        ask: ['Confirm the north star: ' + (f.northStar || SEED.client.northStar) + '. Does that sit right?', 'One rule for scope: if Claude cannot carry the core of it, it is parked, not dropped.'] },
      { id: 'a2', mins: 10, title: 'Map the systems', view: 'systems',
        say: 'Before we talk about work, tell me what you touch. Correct anything on the screen and add what is missing.',
        ask: ['Which of these do you open every day?', 'Which two do you copy between most?', 'What is missing from this list?', 'Which system do you trust least?'] }
    ];
    fns.forEach(function (fn, i) {
      agenda.push({ id: 'w' + (i + 1), mins: per, title: 'Walk the ' + fn + ' process', view: 'process',
        say: (i === 0 ? fn + ' first. ' : 'Now ' + fn + '. ') + 'Phase by phase. I want how it actually happens, not the policy.' + (i > 0 ? ' Everyone else, listen for where their pain is your pain.' : ''),
        ask: ['What happens, who owns it, how often, how long, what tool?', 'Where does the same thing get typed twice?', 'What is the drop-everything task?', 'What do you produce every month that looks the same each time?'] });
    });
    agenda.push(
      { id: 'a5', mins: 5, title: 'Pause and catch up', view: 'opportunities', say: 'Stretch. While you do, the board catches up. I will tidy titles and tag teams.', ask: ['Facilitator: merge duplicates, fix team tags, park anything out of scope with a reason.'] },
      { id: 'a6', mins: 20, title: 'Validate, cluster, vote', view: 'opportunities', say: 'Here is everything we heard. For each one: is the pain real, is the direction right. Then three dots each.', ask: ['Which team does this belong to, or is it the whole business?', 'Who feels this most?', 'Which one would you hand over tomorrow if you trusted it?', 'Watch for convergence: three people raising the same thing unprompted.'] },
      { id: 'a7', mins: 10, title: 'The second viewpoint', view: 'second', say: 'These are the things we saw from outside, written from what you said today. For each one I will tell you why I think it did not come up.', ask: ['Which of these is obviously right?', 'Which one makes you uncomfortable, and why?', 'Which is already being done somewhere you know of?'] },
      { id: 'a8', mins: 10, title: 'Commit and export', view: 'opportunities', say: 'Top five by votes. An owner for each. The first build starts this week.', ask: ['Who owns each of the top five?', 'What is the first skill we write together?', 'Export the register and send it to the room today.'] }
    );
    return {
      client: { name: f.client, short: f.client, functions: fns, headcount: 0, about: f.about || '', northStar: f.northStar || SEED.client.northStar, scopeCriterion: f.scopeCriterion || SEED.client.scopeCriterion, aiPlatform: SEED.client.aiPlatform },
      functionsTags: tags, surfaces: SEED.surfaces, buildTypes: SEED.buildTypes, statuses: SEED.statuses, questionBank: SEED.questionBank,
      agenda: agenda, systems: [], phases: [], blindSpots: [], demoTranscript: []
    };
  }
  function adminCreateWorkshop() {
    var v = function (id) { var el = $('#' + id); return el ? el.value.trim() : ''; };
    var title = v('n_title'), client = v('n_client') || title; if (!title) { toast('Give the workshop a title'); return; }
    var slugify = function (t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Math.random().toString(36).slice(2, 6); };
    var fns = v('n_fns').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var cfg = blankConfig({ client: client, functions: fns, about: v('n_about'), northStar: v('n_north'), scopeCriterion: v('n_scope') });
    var orgP = v('n_org') ? Promise.resolve({ id: v('n_org') }) : (v('n_orgname') ? SB.createOrg(v('n_orgname'), slugify(v('n_orgname'))) : Promise.reject(new Error('Pick an organisation or name a new one')));
    orgP.then(function (org) { return SB.createWorkshop(org.id, { slug: slugify(title), title: title, joinCode: v('n_code') || '1234', maxDots: parseInt(v('n_dots'), 10) || 3 }, cfg); })
      .then(function (w) { toast('Created. Opening…'); location.href = location.pathname + '?w=' + encodeURIComponent(w.slug); })
      .catch(function (e) { toast(e.message || 'Could not create'); });
  }

  /* --------------------------------------------------------------- boot -- */
  load();
  applyTheme();
  brandLines();
  bind();
  syncOps();
  RUN.lastCount = REG.countedOpportunities(S.reg).length;
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
      S.reg = REG.empty(); S.opportunities = []; S.transcript = []; S.secondAI = []; S.revealed = false; S.agendaIdx = -1; S.blockDone = {};
      SB.on('data', applyData); SB.on('toast', toast); SB.on('auth', route); SB.on('register', reloadRegister);
      route();
    }).catch(function () { localBoot(); });
  } else localBoot();

  window.WOS = { state: S, addTranscript: addTranscript, addOpportunity: addOpportunity, extractNow: extractNow, exportXlsx: exportXlsx, change: change, render: render };
})();
