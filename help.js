/* ============================================================================
   help.js: every explanation on the page, in one place.

   Three layers, because a hover alone is easy to miss:
     1. Tooltips. Hover or keyboard-focus any control or tag and a plain-words
        description appears. Resolved from the element's data attributes so
        the render code does not have to carry the text.
     2. "How to use this view", a fold-out under every page heading with
        numbered steps.
     3. The guide panel, opened by the "How to use" button and automatically
        on the very first visit.
   ========================================================================== */
window.HELP = (function () {
  'use strict';

  var tips = {
    view: {
      runsheet: 'Your agenda for the 90 minutes. Start here. Each block has what to say and what to ask.',
      systems: 'The software the team uses. Confirm or correct it with the room in block 2.',
      process: 'The Finance and Purchasing work, split into phases. Ideas get pinned to a phase so you can see where the pain clusters.',
      opportunities: 'The board. Every idea the room or Claude raised, with tags. Edit, vote and export from here.',
      second: 'Ideas from outside the room. Stays locked until you press Reveal in block 7.',
      live: 'Where the transcript comes in and where Claude reads it. Only you see this.',
      settings: 'AI key, Wispr Flow meeting, feed URL, theme. Only you see this.'
    },
    action: {
      start: 'Starts the clock on block 1 and switches to the view that block needs.',
      goto: 'Jump to this block. Starts its timer and opens the right view.',
      toggleask: 'Show or hide the questions to ask during this block.',
      addsystem: 'Add a system the room uses that is not on the list.',
      editsystem: 'Change the name, category, who uses it, or what Claude can reach.',
      newop: 'Add an idea by hand. Use this when someone says something Claude missed.',
      edit: 'Open the full form for this idea: tags, pain, what Claude does, owner, notes.',
      validate: 'Mark this idea as confirmed by the room: the pain is real and the direction is right.',
      vote: 'Add or remove a dot vote. Give each person three dots in block 6.',
      export: 'Download an Excel workbook: the register, the second viewpoint, the systems and the phase heat map.',
      exportjson: 'Download everything as a JSON file, transcript included. A backup.',
      importjson: 'Load a JSON backup. Ideas already on the board are not duplicated.',
      reveal: 'Unseals the second viewpoint. Counts up the ideas the room raised, then ours. If AI is on, also asks Claude for blind spots from the transcript.',
      regen: 'Ask Claude again for blind spots, using everything in the transcript so far.',
      reseal: 'Lock the second viewpoint again. Use it after a test run.',
      promote: 'Copy this idea onto the main board so it can be voted on and exported.',
      'src-mic': 'Use this laptop’s microphone. Chrome only. Rough but live.',
      'src-wispr': 'Read the Wispr Flow meeting recording as it happens. Works only in the Artifact version with the connector.',
      'src-feed': 'Poll a JSON file on the web that another Claude session keeps writing to.',
      'src-demo': 'Play a made-up transcript, one line every nine seconds, so you can watch ideas appear.',
      stopsrc: 'Stop the current transcript source.',
      addmanual: 'Send what you typed or dictated into the transcript. Claude reads it on the next pass.',
      extract: 'Make Claude read the unread transcript now instead of waiting for the timer.',
      cleartranscript: 'Delete the captured transcript. Ideas on the board stay.',
      savesettings: 'Save these settings in this browser.',
      resetall: 'Wipe the board, transcript and settings from this browser. Export first.',
      resetsystems: 'Put the systems list back to the starting guess.',
      newidea: 'Add an idea of your own. It lands on the board for everyone, with your name on it.',
      copylink: 'Copy the link participants open on their phone.',
      sendlink: 'We email you a sign-in link. No password.',
      joincode: 'Enter the code shown on the screen to join this workshop.',
      signout: 'Sign out of the board on this device.',
      openws: 'Open this workshop on the board.',
      createws: 'Create a new workshop from the template. You become its facilitator.',
      showtoken: 'Reveal the bridge token for this workshop.',
      copytoken: 'Copy the bridge token.',
      dismissguide: 'Hide this starter card. The full guide stays under the How to use button.',
      openhelp: 'Open the full guide.'
    },
    id: {
      opBadge: 'How many ideas are on the board. It bumps when a new one lands.',
      secondLock: 'Locked means the room cannot see the second viewpoint yet. Open means it has been revealed.',
      btnTimer: 'Start or pause the clock for the current block. The Space key does the same.',
      btnNext: 'Move to the next block. The N key does the same.',
      btnPresent: 'Presentation mode: hides your controls and enlarges the type for the projector. The P key toggles it.',
      btnHelp: 'The guide: what this page is, what to do first, and what every word means.',
      aiStatus: 'Whether Claude can read the transcript right now. Ready or listening is good. Off means add a key in Settings or run this as an Artifact.',
      aiDot: 'Green pulsing: Claude is listening. Gold: reading now. Red: an error, see the log in Live capture.',
      srcStatus: 'Which transcript source is running, if any.',
      srcDot: 'Green pulsing means a transcript source is running.',
      modeStatus: 'How this page is running: as an Artifact with Claude built in, or standalone with your own key.',
      nowBlock: 'The block you are in and how long it should take.',
      nowTime: 'Time spent in this block. Turns red when you are over.',
      manualBox: 'Type here, or put the cursor here and press your Wispr Flow hotkey to dictate. Ctrl or Cmd plus Enter adds it to the transcript.',
      autoExtract: 'When ticked, Claude reads new transcript on a timer without you pressing anything.',
      liveLog: 'What the page has done, newest first. Errors show here.',
      feed: 'Everything captured so far, newest at the bottom.',
      tChars: 'Total characters of transcript captured so far.',
      tPending: 'Characters Claude has not read yet. Drops to zero after each read.',
      tOps: 'Ideas on the board right now.',
      tAI: 'Ideas that Claude added from the transcript, as opposed to by hand.',
      setKey: 'Your Anthropic API key. Used only from this browser and never shared. Needed only when this page is not running as a claude.ai Artifact.',
      setModel: 'Which Claude model reads the transcript. Opus 5 is the default.',
      setPoll: 'How often Claude reads new transcript, in seconds. 60 is a good default.',
      setMin: 'Claude waits until at least this much new text has arrived before reading.',
      wisprMeeting: 'The Wispr Flow recording to read from. Start the recording first, then pick it here.',
      setWisprPoll: 'How often to ask Wispr Flow for new transcript, in seconds. Minimum 30.',
      setFeed: 'Web address of a JSON file that another Claude session keeps updating.',
      setFeedPoll: 'How often to check the feed, in seconds.',
      stFilter: 'Show only ideas with this status.',
      qFilter: 'Search ideas by any word in the title, pain, phase or who raised it.',
      sheetSave: 'Save the form.',
      sheetDelete: 'Delete for good. Consider setting the status to Parked instead, which keeps a record.',
      sheetClose: 'Close without saving.'
    },
    mode: {
      cards: 'Cards: one idea per card with the full story. Best for the projector.',
      table: 'Table: a spreadsheet view. Click any cell to edit it in place.'
    },
    fn: {
      All: 'Show every idea.',
      Finance: 'Show only ideas that belong to the Finance team.',
      Purchasing: 'Show only ideas that belong to the Purchasing team.',
      Both: 'Show ideas that need both teams.',
      'Org-wide': 'Show ideas that reach the whole business.'
    },
    sysstatus: {
      confirmed: 'Confirmed: the room said they use this.',
      assumed: 'Assumed: my guess before the session. Ask the room.',
      unknown: 'Unknown: not sure it exists here. Ask the room.'
    },
    theme: { '': 'Follow the laptop’s light or dark setting.', dark: 'Always dark. Best for a projector in a dim room.', light: 'Always light.' },
    field: {
      title: 'Click to rename. Enter saves.',
      pain: 'The problem in the team’s own words. Click to edit.',
      direction: 'What Claude would actually do: the input it reads and the output it produces. Click to edit.',
      systems: 'The systems this idea touches, separated by commas. Click to edit.',
      raisedBy: 'Who said it. Click to edit.',
      owner: 'The person in the room who will own this idea after today. Click to edit.',
      fn: 'Which team this belongs to.',
      phase: 'Where in the process this idea sits.',
      surface: 'Which part of Claude carries this idea.',
      build: 'What has to be built for it to work.',
      status: 'Where this idea is in its life: Open, Validated, Emerging, Parked or Merged.'
    },
    chipFn: {
      Finance: 'This idea belongs to the Finance team.',
      Purchasing: 'This idea belongs to the Purchasing team.',
      Both: 'This idea needs both Finance and Purchasing.',
      'Org-wide': 'This idea reaches the whole business, not just these two teams.'
    },
    chipStatus: {
      Open: 'Open: heard, not yet confirmed by the room.',
      Validated: 'Validated: the room confirmed the pain is real and the direction is right.',
      Emerging: 'Emerging: came up late. Confirm it next time.',
      Parked: 'Parked: out of scope or deprioritised. Kept with a reason, never built.',
      Merged: 'Merged: folded into another idea. Kept for the record.'
    },
    chipSrc: {
      AI: 'Claude heard this in the transcript and added it by itself.',
      Room: 'Added by hand during the session.',
      Consultant: 'From the prepared second viewpoint.'
    },
    build: {
      Skill: 'Skill: a written procedure Claude follows on demand, like an SOP a new starter could use.',
      'Scheduled task': 'Scheduled task: a prompt that runs on a timer, for example every Monday or every month-end, with the connectors it needs.',
      Setup: 'Setup: connect a system or load a Project before anything else can work.',
      Project: 'Project: a standing Claude workspace with instructions and reference files loaded once.',
      'Workflow redesign': 'Workflow redesign: the human steps change and Claude carries one stage of them.'
    },
    other: {
      confidence: 'How sure we are this idea will pay off. High, Medium or Low.',
      phaseCount: 'How many ideas have landed on this phase. A high number means a cluster of pain, not six separate features.',
      frameNorth: 'The one thing every idea is measured against. Say it out loud in block 1.',
      frameScope: 'The test for whether an idea is in or out. If Claude cannot carry the core of it, it is parked, not dropped.',
      blockMins: 'How long this block should take.',
      claudeReach: 'Whether Claude can already see this system, and through which connector.'
    }
  };

  var surfaceTell = {};
  (window.SEED ? SEED.surfaces : []).forEach(function (s) { surfaceTell[s.key] = s.key + ': for when they say "' + s.tell + '". ' + s.build; });
  var phaseNames = {};
  (window.SEED ? SEED.phases : []).forEach(function (p) { phaseNames[p.name] = 'Process phase: ' + p.what; });

  function chipTip(cls, txt) {
    var m;
    if ((m = /chip--fn-([\w-]+)/.exec(cls))) return tips.chipFn[m[1]] || '';
    if ((m = /chip--status-(\w+)/.exec(cls))) return tips.chipStatus[m[1]] || '';
    if ((m = /chip--src-(\w+)/.exec(cls))) return tips.chipSrc[m[1]] || '';
    if ((m = /chip--st-(\w+)/.exec(cls))) return tips.sysstatus[m[1]] || '';
    if (surfaceTell[txt]) return surfaceTell[txt];
    if (tips.build[txt]) return tips.build[txt];
    if (phaseNames[txt]) return phaseNames[txt];
    if (/confidence$/.test(txt)) return tips.other.confidence;
    if (/^Owner:/.test(txt)) return 'The person who owns this idea after today.';
    if (txt === 'Claude, today') return 'Claude wrote this idea from today’s transcript when you pressed Reveal.';
    if (txt === 'Consultant') return tips.chipSrc.Consultant;
    if (txt === 'AI heard it') return tips.chipSrc.AI;
    return '';
  }

  /* Who each thing is for. "you" = facilitator only (hidden in presentation
     mode). "room" = the participants see it on the projector. "both" = you
     press it while the room watches. Anything not listed defaults by group. */
  var who = {
    view: { runsheet: 'you', systems: 'both', process: 'both', opportunities: 'both', second: 'both', live: 'you', settings: 'you' },
    action: { validate: 'both', vote: 'both', export: 'both', reveal: 'both', promote: 'both', newidea: 'room', joincode: 'room', sendlink: 'room' },
    id: { opBadge: 'room', secondLock: 'room', nowBlock: 'room', nowTime: 'room', tOps: 'room' },
    mode: { cards: 'both', table: 'you' },
    chip: 'room', phaseCount: 'room', blockMins: 'room', field: 'you'
  };
  var whoLabel = { you: 'You', room: 'Room', both: 'You and the room' };
  function whoFor(el) {
    if (!el || !el.dataset) return 'you';
    var d = el.dataset;
    if (d.who) return d.who;
    if (d.action) return who.action[d.action] || 'you';
    if (d.view) return who.view[d.view] || 'you';
    if (d.m) return who.mode[d.m] || 'you';
    if (el.id && who.id[el.id]) return who.id[el.id];
    if (el.classList && el.classList.contains('chip')) return who.chip;
    if (el.classList && el.classList.contains('phase__count')) return who.phaseCount;
    if (el.classList && el.classList.contains('block__mins')) return who.blockMins;
    return 'you';
  }

  function tipFor(el) {
    if (!el || !el.dataset) return '';
    var d = el.dataset;
    if (d.tip) return d.tip;
    if (d.action && tips.action[d.action]) return tips.action[d.action];
    if (d.view && tips.view[d.view]) return tips.view[d.view];
    if (d.m && tips.mode[d.m]) return tips.mode[d.m];
    if (d.f && tips.fn[d.f]) return tips.fn[d.f];
    if (d.st && tips.sysstatus[d.st]) return tips.sysstatus[d.st];
    if (d.t !== undefined && el.closest && el.closest('#themeSeg')) return tips.theme[d.t] || '';
    if (el.id && tips.id[el.id]) return tips.id[el.id];
    if (d.field && tips.field[d.field]) return tips.field[d.field];
    if (el.classList && el.classList.contains('phase__count')) return tips.other.phaseCount;
    if (el.classList && el.classList.contains('block__mins')) return tips.other.blockMins;
    return '';
  }

  /* --------------------------------------------------------- howto -- */
  var howto = {
    runsheet: ['Press Start the session when the room is ready. The clock starts on block 1.', 'Read the grey line out loud: it is your script. Press Questions to see what to ask.', 'When a block is done press Next block, or the N key. The page switches to the view that block needs.', 'Keep this tab on your laptop. Press P before you plug into the projector.'],
    systems: ['In block 2, walk the cards with the room.', 'Press C, A or U on each card: Confirmed, Assumed, Unknown.', 'Press Edit to fix a name or note. Press Add a system if one is missing.', 'The Claude reach line says whether Claude can already see that system.'],
    process: ['In blocks 3 and 4, click a card to see the questions to ask about that phase.', 'Ideas Claude hears appear under the phase they belong to. The big number counts them.', 'If someone says something Claude missed, press Add opportunity here on that phase.'],
    opportunities: ['Every idea lands here with a number. The badge in the sidebar bumps when one arrives.', 'Click a title to rename it. Press Edit for the full form. Table mode is a spreadsheet you can type into.', 'In block 6 use the plus and minus for dot votes. Press Validate when the room confirms an idea.', 'Use the filters to show only Finance, only Purchasing, or only one status.', 'Press Export Excel at the end of the session.'],
    second: ['Keep it locked until block 7.', 'Press Reveal, then scroll slowly. The numbers count up, then the ideas appear.', 'For each idea, read the "why you did not raise it" line to the room.', 'Press Put it on the board for any idea the room wants to keep.'],
    live: ['Pick one source. Demo transcript is the safest way to test.', 'Or click in the box, press your Wispr Flow hotkey, dictate a sentence, then press Add to transcript.', 'Claude reads new text every 60 seconds and adds ideas to the board. Press Read now to force it.', 'The AI line in the sidebar must say ready or listening. If it says off, go to Settings.'],
    settings: ['If this page is running as a claude.ai Artifact, AI is already on. Nothing to add.', 'Otherwise paste an Anthropic API key and press Save settings.', 'For Wispr Flow, start recording the meeting first, then pick it in the dropdown.', 'Press Save settings after any change.']
  };
  function howtoHtml(view) {
    var steps = howto[view]; if (!steps) return '';
    return '<details class="howto"><summary>How to use this view</summary><ol>' + steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol></details>';
  }

  /* ---------------------------------------------------------- guide -- */
  var guide = [
    { title: 'What this page is', body: '<p>A board for running a 90-minute workshop. You talk the room through their work. Claude listens to the transcript and puts each idea on the board with a number. At the end you reveal the ideas they did not think of, and export everything to Excel.</p><p>The left sidebar is the map. The top bar is the clock. Everything marked facilitator-only disappears in presentation mode.</p>' },
    { title: 'The tags on every hover', body: '<p>Hover anything and a note appears with a tag.</p><p><span class="tip__who tip__who--you">You</span> means facilitator only. The room never sees it, and it disappears in presentation mode.</p><p><span class="tip__who tip__who--room">Room</span> means the participants see it on the projector.</p><p><span class="tip__who tip__who--both">You and the room</span> means you press it while the room watches, for example Reveal or a vote.</p>' },
    { title: 'Before the day: a five-minute test', steps: ['Open Settings. The AI line in the sidebar should say ready. If it says off, paste an API key and save.', 'Open Live capture and press Demo transcript. Watch the Opportunities badge climb over the next few minutes.', 'Open Opportunities. Click a title and rename it. Press plus to vote. Press Export Excel and open the file.', 'Open Second viewpoint and press Reveal. Scroll down slowly.', 'Press Re-seal, then in Settings press Reset the whole board, so the real session starts clean.'] },
    { title: 'On the day', steps: ['Open Live capture and start your transcript source: Wispr Flow meeting, or dictation into the box.', 'Plug in the projector and press P for presentation mode.', 'Open Run sheet and press Start the session.', 'Follow the blocks. Press Next block when each one is done. The page moves to the right view for you.', 'Block 7: open Second viewpoint and press Reveal.', 'Block 8: open Opportunities and press Export Excel. Send the file to the room.'] },
    { title: 'What the words mean', terms: [['Opportunity', 'One idea: a task Claude could carry. It has a title, a team, a phase, a surface, a build type and a status.'], ['Function', 'Which team it belongs to: Finance, Purchasing, Both, or Org-wide.'], ['Phase', 'Where in the process the idea sits, for example Accounts payable or Purchase orders. The Process walk view counts ideas per phase.'], ['Surface', 'Which part of Claude does the work: Chat, a Project, a Scheduled Task, Cowork, a Skill, or a Connector setup.'], ['Build type', 'What has to be made: a Skill, a Scheduled task, a Setup, a Project, or a Workflow redesign.'], ['Status', 'Open, Validated, Emerging, Parked or Merged. Hover any status tag for the meaning.'], ['Second viewpoint', 'Ideas from outside the room: twelve prepared in advance plus what Claude writes from today’s transcript. Each one says why the room did not raise it.'], ['Votes', 'Dot votes. Each person gets three in block 6. The list sorts by votes.'], ['Transcript source', 'Where the words come from: the Wispr Flow meeting, the laptop mic, dictation into the box, a JSON feed, or the demo.']] },
    { title: 'Keys', terms: [['1 to 7', 'Switch views.'], ['Space', 'Start or pause the block clock.'], ['N', 'Next block.'], ['P', 'Presentation mode on or off.'], ['Esc', 'Close a panel.']] }
  ];
  var participantGuide = [
    { title: 'You are a participant', body: '<p>The facilitator drives the session from the big screen. This page on your phone is for three things.</p>' },
    { title: 'What you can do', steps: ['Read the ideas as they land. New ones appear on their own; no need to refresh.', 'Vote. You have a few dots. Press plus on an idea to spend one, minus to take it back. The board sorts by votes as you go.', 'Add an idea the room missed. Press Add an idea, one line is enough. It lands with your name on it.'] },
    { title: 'What the tags mean', terms: [['Finance / Purchasing / Both / Org-wide', 'Whose work the idea belongs to.'], ['Scheduled Task, Skill, Project, Cowork', 'Which part of Claude would carry it. Hover any tag for a plain-words note.'], ['Open / Validated / Parked', 'Where the idea is: heard, confirmed by the room, or set aside with a reason.']] }
  ];
  function guideHtml() {
    var src = document.body.classList.contains('participant') ? participantGuide : guide;
    return src.map(function (g) {
      var h = '<section class="guide__section"><h3>' + g.title + '</h3>';
      if (g.body) h += g.body;
      if (g.steps) h += '<ol>' + g.steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>';
      if (g.terms) h += '<dl class="terms">' + g.terms.map(function (t) { return '<dt>' + t[0] + '</dt><dd>' + t[1] + '</dd>'; }).join('') + '</dl>';
      return h + '</section>';
    }).join('');
  }

  /* -------------------------------------------------------- tooltip -- */
  var tipEl, showT, current = null;
  function findTipped(start) {
    var el = start, n = 0;
    while (el && el !== document.body && n < 6) {
      if (el.nodeType === 1 && tipFor(el)) return el;
      el = el.parentNode; n++;
    }
    return null;
  }
  function show(el) {
    var text = tipFor(el); if (!text) return;
    current = el;
    var w = whoFor(el);
    tipEl.innerHTML = '<span class="tip__who tip__who--' + w + '">' + whoLabel[w] + '</span>' + text.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
    tipEl.hidden = false;
    var r = el.getBoundingClientRect(), tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    var top = r.bottom + 8;
    if (top + th > window.innerHeight - 8) top = r.top - th - 8;
    tipEl.style.left = left + 'px'; tipEl.style.top = top + 'px';
  }
  function hide() { clearTimeout(showT); current = null; if (tipEl) tipEl.hidden = true; }
  function mount() {
    tipEl = document.getElementById('tip'); if (!tipEl) return;
    document.addEventListener('mouseover', function (e) {
      var el = findTipped(e.target);
      if (!el) { hide(); return; }
      if (el === current) return;
      clearTimeout(showT); showT = setTimeout(function () { show(el); }, 220);
    });
    document.addEventListener('mouseout', function (e) { var el = findTipped(e.target); if (el && el === current && !el.contains(e.relatedTarget)) hide(); });
    document.addEventListener('focusin', function (e) { var el = findTipped(e.target); if (el) show(el); });
    document.addEventListener('focusout', hide);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('mousedown', hide);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  }

  return { tips: tips, tipFor: tipFor, whoFor: whoFor, chipTip: chipTip, howto: howto, howtoHtml: howtoHtml, guideHtml: guideHtml, mount: mount, hide: hide };
})();
