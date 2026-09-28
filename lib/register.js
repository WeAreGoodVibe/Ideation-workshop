/* ============================================================================
   lib/register.js: the hierarchical opportunity register.

   Pure logic: no storage, no network, no DOM. The page, the Vercel functions
   and the Node scripts all load this one file, so the rules for "attach or
   create", "same item or new one", "blocked or not" cannot drift apart.

   A register is a plain object:
     opportunities  top-level recurring workflows (O1, O2 ...)
     items          children, each with a parent Opportunity (O3.1, O3.2 ...)
     enablers       organisation-wide blockers linked to many Opportunities (E1 ...)
     learning       ways of working and training points (L1 ...), never counted
     triage         captures the classifier was not sure about (T1 ...)
     log            every structural change, newest last
     aliases        old ID -> new ID, so a reference to a moved item still resolves

   Loaded as window.REG in the browser and with require() in Node.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.REG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* --------------------------------------------------------- vocabulary -- */
  var CHILD_TYPES = ['build_step', 'guardrail', 'dependency', 'setup_action', 'open_question'];
  var CAPTURE_TYPES = ['opportunity'].concat(CHILD_TYPES, ['enabler', 'learning']);
  var TYPE_LABELS = {
    opportunity: 'Opportunity', build_step: 'Build step', guardrail: 'Guardrail', dependency: 'Dependency',
    setup_action: 'Setup action', open_question: 'Open question', enabler: 'Enabler', learning: 'Learning item'
  };
  var STATUSES = ['Identified', 'Qualified', 'In build', 'Built', 'In use', 'Parked'];
  var ITEM_STATUSES = ['Open', 'Done'];
  var ORIGINS = ['Client-raised', 'Proposed'];
  var TIME_BANDS = ['Under 15 min', '15 to 60 min', '1 to 4 hours', 'Over 4 hours'];
  var ENABLER_OWNERS = ['Client', 'IT provider', 'Consultant'];
  var CREATED_BY = ['live', 'second viewpoint', 'manual', 'migration'];
  var QUALIFY_FIELDS = ['owner', 'frequency', 'timeBand', 'fn', 'phase', 'systems', 'problem', 'claudeDoes', 'surface'];
  var FIELD_LABELS = { owner: 'owner', frequency: 'trigger', timeBand: 'time per round', fn: 'function', phase: 'phase', systems: 'systems', problem: 'problem', claudeDoes: 'what Claude does', surface: 'surface' };

  /* Every tunable number in one place. `merge` is how alike two items at the
     same level must be (0 to 1) before the second becomes evidence on the
     first. `attach` is the least an Opportunity must score against a capture
     before code will choose it as the parent when the model named none.
     `triage` is the least model confidence that goes straight onto the
     register. Tuned against the anonymised fixture; see test/fixtures. */
  var THRESHOLDS = { merge: 0.62, attach: 0.34, triage: 0.6, maxOpportunities: 15, minChildShare: 0.6 };

  /* The unit test: what an Opportunity must name to be a real workflow. */
  var UNIT_FIELDS = [
    { field: 'owner', question: 'Who owns this workflow, by name or role?' },
    { field: 'frequency', question: 'What triggers this workflow, or how often does it run?' },
    { field: 'timeBand', question: 'Roughly how long does one round take today?' }
  ];

  /* ---------------------------------------------------------- similarity -- */
  var STOP = {};
  ('a an and are as at be by for from has have in into is it its of on or our so that the their them then this to up was we were will with ' +
   'when what which who each every all any can do does get go make need needs should would could want use using via per').split(' ')
    .forEach(function (w) { STOP[w] = 1; });

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function stem(w) {
    if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /ed$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function tokens(s) {
    var out = [];
    norm(s).split(' ').forEach(function (w) { if (w && !STOP[w]) out.push(stem(w)); });
    return out;
  }
  function trigrams(s) {
    var t = ' ' + tokens(s).join(' ') + ' ', set = {};
    for (var i = 0; i < t.length - 2; i++) set[t.slice(i, i + 3)] = 1;
    return set;
  }
  function jaccard(a, b) {
    var A = {}, B = {}, inter = 0, uni = 0, k;
    a.forEach(function (x) { A[x] = 1; }); b.forEach(function (x) { B[x] = 1; });
    for (k in A) { uni++; if (B[k]) inter++; }
    for (k in B) if (!A[k]) uni++;
    return uni ? inter / uni : 0;
  }
  function dice(A, B) {
    var na = 0, nb = 0, inter = 0, k;
    for (k in A) { na++; if (B[k]) inter++; }
    for (k in B) nb++;
    return na + nb ? (2 * inter) / (na + nb) : 0;
  }
  /* How alike two short texts are, 0 to 1. Word overlap catches reworded
     titles; character trigrams catch plurals, typos and run-together words. */
  function similarity(a, b) {
    var ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    if (ta.join(' ') === tb.join(' ')) return 1;
    return 0.5 * jaccard(ta, tb) + 0.5 * dice(trigrams(a), trigrams(b));
  }
  function overlap(a, b) {
    var A = {}; (a || []).forEach(function (x) { A[norm(x)] = 1; });
    return (b || []).some(function (x) { return A[norm(x)]; });
  }
  /* How well a capture fits an Opportunity: text similarity plus small
     bonuses for the structured signals the spec names (phase, systems,
     owner). A bonus alone can never make a match; it only breaks ties. */
  function fitScore(opp, cap) {
    var text = cap.title || cap.text || '';
    var s = Math.max(similarity(opp.title, text), 0.8 * similarity(opp.title + ' ' + (opp.problem || '') + ' ' + (opp.claudeDoes || ''), text));
    if (cap.phase && opp.phase && norm(cap.phase) === norm(opp.phase)) s += 0.08;
    if (overlap(opp.systems, cap.systems)) s += 0.05;
    if (cap.owner && opp.owner && norm(cap.owner) === norm(opp.owner)) s += 0.05;
    return Math.min(1, s);
  }
  function bestMatch(list, text, scoreFn) {
    var best = null, bestScore = 0;
    list.forEach(function (x) {
      var s = scoreFn ? scoreFn(x) : similarity(x.text || x.title, text);
      if (s > bestScore) { best = x; bestScore = s; }
    });
    return { item: best, score: bestScore };
  }

  /* ------------------------------------------------------------ helpers -- */
  function empty() {
    return { opportunities: [], items: [], enablers: [], learning: [], triage: [], log: [], aliases: {} };
  }
  function clone(reg) { return JSON.parse(JSON.stringify(reg)); }
  function resolve(reg, id) {
    var seen = 0;
    while (id && reg.aliases && reg.aliases[id] && seen++ < 50) id = reg.aliases[id];
    return id;
  }
  function findOpp(reg, id) { id = resolve(reg, id); return reg.opportunities.filter(function (o) { return o.id === id; })[0] || null; }
  function findItem(reg, id) { id = resolve(reg, id); return reg.items.filter(function (i) { return i.id === id; })[0] || null; }
  function findEnabler(reg, id) { id = resolve(reg, id); return reg.enablers.filter(function (e) { return e.id === id; })[0] || null; }
  function findAny(reg, id) {
    id = resolve(reg, id);
    var o = findOpp(reg, id); if (o) return { kind: 'opportunity', row: o };
    var i = findItem(reg, id); if (i) return { kind: 'item', row: i };
    var e = findEnabler(reg, id); if (e) return { kind: 'enabler', row: e };
    var l = reg.learning.filter(function (x) { return x.id === id; })[0]; if (l) return { kind: 'learning', row: l };
    var t = reg.triage.filter(function (x) { return x.id === id; })[0]; if (t) return { kind: 'triage', row: t };
    return null;
  }
  function childrenOf(reg, oppId) { oppId = resolve(reg, oppId); return reg.items.filter(function (i) { return i.parentId === oppId; }); }
  function maxNum(ids, re) {
    var m = 0; ids.forEach(function (id) { var x = re.exec(id || ''); if (x) m = Math.max(m, parseInt(x[1], 10)); }); return m;
  }
  /* IDs are never reused, even after a delete or a merge: the numbers go up
     from the highest ever issued, which the aliases remember. */
  function allIds(reg) {
    return [].concat(reg.opportunities.map(function (o) { return o.id; }), reg.items.map(function (i) { return i.id; }),
      reg.enablers.map(function (e) { return e.id; }), reg.learning.map(function (l) { return l.id; }),
      reg.triage.map(function (t) { return t.id; }), Object.keys(reg.aliases || {}));
  }
  function nextOppId(reg) { return 'O' + (maxNum(allIds(reg), /^O(\d+)$/) + 1); }
  function nextChildId(reg, parentId) {
    var re = new RegExp('^' + parentId.replace(/\./g, '\\.') + '\\.(\\d+)$');
    return parentId + '.' + (maxNum(allIds(reg), re) + 1);
  }
  function nextPrefixed(reg, prefix) { return prefix + (maxNum(allIds(reg), new RegExp('^' + prefix + '(\\d+)$')) + 1); }
  function nowIso(opts) { return (opts && opts.now) || new Date().toISOString(); }
  function logChange(reg, action, detail, opts) {
    reg.log.push({ at: nowIso(opts), action: action, by: (opts && opts.by) || 'system', detail: detail });
  }

  function cleanEvidence(ev) {
    return (Array.isArray(ev) ? ev : ev ? [ev] : []).filter(function (e) { return e && String(e.quote || '').trim(); }).map(function (e) {
      return { quote: String(e.quote).trim(), speaker: String(e.speaker || '').trim(), at: String(e.at || '').trim(), source: String(e.source || '').trim() };
    });
  }
  /* Evidence is appended, never replaced; the same quote twice is kept once. */
  function addEvidence(target, ev) {
    target.evidence = target.evidence || [];
    var have = {}; target.evidence.forEach(function (e) { have[norm(e.quote)] = true; });
    var added = 0;
    cleanEvidence(ev).forEach(function (e) { if (!have[norm(e.quote)]) { have[norm(e.quote)] = true; target.evidence.push(e); added++; } });
    return added;
  }

  /* -------------------------------------------------- unit test, blocked -- */
  function missingUnitFields(opp) { return UNIT_FIELDS.filter(function (u) { return !String(opp[u.field] || '').trim(); }).map(function (u) { return u.field; }); }
  function needsQualification(opp) { return missingUnitFields(opp).length > 0; }

  /* Each missing unit-test field is an Open question on the Opportunity; it
     closes itself when the field is filled, and reopens if it is cleared. */
  function syncQualification(reg, opp, opts) {
    var missing = missingUnitFields(opp);
    UNIT_FIELDS.forEach(function (u) {
      var q = reg.items.filter(function (i) { return i.parentId === opp.id && i.auto === u.field; })[0];
      var isMissing = missing.indexOf(u.field) >= 0;
      if (isMissing && !q) {
        reg.items.push({ id: nextChildId(reg, opp.id), parentId: opp.id, type: 'open_question', text: u.question, status: 'Open',
          answerBy: 'Client', evidence: [], createdBy: (opts && opts.createdBy) || 'live', auto: u.field });
      } else if (q) {
        q.status = isMissing ? 'Open' : 'Done';
      }
    });
    opp.needsQualification = missing.length > 0;
  }

  /* Blocked is never stored. It is true while the Opportunity has an open
     Dependency of its own, or is linked to an Enabler that is still open. */
  function blockers(reg, oppId) {
    oppId = resolve(reg, oppId);
    var deps = reg.items.filter(function (i) { return i.parentId === oppId && i.type === 'dependency' && i.status !== 'Done'; });
    var ens = reg.enablers.filter(function (e) { return e.status !== 'Done' && (e.links || []).indexOf(oppId) >= 0; });
    return { dependencies: deps, enablers: ens };
  }
  function isBlocked(reg, oppId) { var b = blockers(reg, oppId); return b.dependencies.length + b.enablers.length > 0; }
  function displayStatus(reg, opp) { return opp.status !== 'Parked' && isBlocked(reg, opp.id) ? 'Blocked' : opp.status; }

  function childCounts(reg, oppId) {
    var c = {}; CHILD_TYPES.forEach(function (t) { c[t] = 0; });
    childrenOf(reg, oppId).forEach(function (i) { c[i.type] = (c[i.type] || 0) + 1; });
    return c;
  }
  /* Only live Opportunities count: not Parked, and a Proposed one only once
     the client has confirmed it. */
  function counts(opp) { return opp.status !== 'Parked' && (opp.origin !== 'Proposed' || !!opp.confirmed); }
  function countedOpportunities(reg) { return reg.opportunities.filter(counts); }

  /* Ease is the consultant's call; this only suggests. Each open blocker
     knocks a point off, never below 1. */
  function suggestEase(reg, opp) {
    var b = blockers(reg, opp.id), n = b.dependencies.length + b.enablers.length;
    if (!n) return null;
    var base = opp.ease == null ? 3 : opp.ease;
    return { ease: Math.max(1, base - Math.min(2, n)), reason: n + ' open blocker' + (n === 1 ? '' : 's') + ': ' +
      b.dependencies.map(function (d) { return d.id; }).concat(b.enablers.map(function (e) { return e.id; })).join(', ') };
  }

  /* Budget warnings: both usually mean attach-before-create is failing. */
  function warnings(reg) {
    var out = [], opps = reg.opportunities.filter(function (o) { return o.status !== 'Parked'; });
    var kids = reg.items.filter(function (i) { return !i.auto && findOpp(reg, i.parentId) && findOpp(reg, i.parentId).status !== 'Parked'; });
    if (opps.length > THRESHOLDS.maxOpportunities) {
      out.push({ code: 'too_many', message: opps.length + ' Opportunities in this session. More than ' + THRESHOLDS.maxOpportunities + ' usually means build steps are being filed as new workflows. Try Consolidate session.' });
    }
    var total = opps.length + kids.length;
    if (total >= 5 && kids.length / total < THRESHOLDS.minChildShare) {
      out.push({ code: 'too_flat', message: Math.round(100 * kids.length / total) + '% of items sit under an Opportunity. Below ' + Math.round(100 * THRESHOLDS.minChildShare) + '% usually means detail is not being attached. Try Consolidate session.' });
    }
    return out;
  }

  /* ------------------------------------------------------------ creation -- */
  function pickEnum(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }
  function arr(v) { return Array.isArray(v) ? v.filter(Boolean).map(String) : String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }

  function createOpportunity(reg, f, opts) {
    opts = opts || {};
    var o = {
      id: f.id && !findAny(reg, f.id) ? f.id : nextOppId(reg),
      title: String(f.title || f.text || '').trim(), fn: String(f.fn || f['function'] || ''), phase: String(f.phase || ''),
      owner: String(f.owner || ''), frequency: String(f.frequency || ''), timeBand: pickEnum(f.timeBand, TIME_BANDS, ''),
      systems: arr(f.systems), problem: String(f.problem || ''), claudeDoes: String(f.claudeDoes || ''), surface: String(f.surface || ''),
      notes: String(f.notes || ''),
      status: pickEnum(f.status, STATUSES, 'Identified'), origin: pickEnum(f.origin, ORIGINS, 'Client-raised'), confirmed: !!f.confirmed,
      value: f.value == null ? null : f.value, ease: f.ease == null ? null : f.ease, votes: f.votes || 0,
      evidence: [], createdBy: pickEnum(opts.createdBy, CREATED_BY, 'live')
    };
    if (o.origin === 'Client-raised') o.confirmed = true;
    addEvidence(o, f.evidence);
    reg.opportunities.push(o);
    syncQualification(reg, o, opts);
    return o;
  }
  /* Facilitator or consultant notes travel with a folded row, labelled with
     where they came from, so a merge or demote never loses them. */
  function carryNotes(into, from) {
    var n = String(from.notes || '').trim(); if (!n || String(into.notes || '').indexOf(n) >= 0) return;
    into.notes = (String(into.notes || '').trim() ? into.notes + '\n' : '') + from.id + ': ' + n;
  }
  /* Fill blanks only: a later capture never overwrites what someone typed. */
  function fillBlanks(opp, f) {
    ['fn', 'phase', 'owner', 'frequency', 'problem', 'claudeDoes', 'surface'].forEach(function (k) {
      var v = k === 'fn' ? (f.fn || f['function']) : f[k];
      if (!String(opp[k] || '').trim() && v) opp[k] = String(v);
    });
    if (!opp.timeBand && TIME_BANDS.indexOf(f.timeBand) >= 0) opp.timeBand = f.timeBand;
    arr(f.systems).forEach(function (s) { if (!overlap(opp.systems, [s])) opp.systems.push(s); });
  }
  function createChild(reg, parentId, f, opts) {
    var type = pickEnum(f.type, CHILD_TYPES, 'build_step');
    var i = { id: nextChildId(reg, parentId), parentId: parentId, type: type, text: String(f.text || '').trim(),
      status: pickEnum(f.status, ITEM_STATUSES, 'Open'), evidence: [], createdBy: pickEnum((opts && opts.createdBy) || f.createdBy, CREATED_BY, 'live') };
    if (type === 'dependency') { i.owner = String(f.owner || ''); i.blockedBy = normBlockedBy(f.blockedBy); }
    if (type === 'open_question') i.answerBy = String(f.answerBy || f.owner || '');
    addEvidence(i, f.evidence);
    reg.items.push(i);
    return i;
  }
  function normBlockedBy(b) {
    b = b || {};
    var kind = pickEnum(b.kind, ['opportunity', 'enabler', 'external'], 'external');
    return { kind: kind, ref: String(b.ref || '') };
  }
  function createEnabler(reg, f, opts) {
    var e = { id: nextPrefixed(reg, 'E'), text: String(f.text || '').trim(), owner: pickEnum(f.owner, ENABLER_OWNERS, 'Client'),
      status: pickEnum(f.status, ITEM_STATUSES, 'Open'), links: [], evidence: [], createdBy: pickEnum((opts && opts.createdBy), CREATED_BY, 'live') };
    (f.links || []).forEach(function (l) { l = resolve(reg, l); if (findOpp(reg, l) && e.links.indexOf(l) < 0) e.links.push(l); });
    addEvidence(e, f.evidence);
    reg.enablers.push(e);
    return e;
  }
  function linkEnabler(reg, e, oppIds) {
    (oppIds || []).forEach(function (l) { l = resolve(reg, l); if (findOpp(reg, l) && e.links.indexOf(l) < 0) e.links.push(l); });
  }

  /* --------------------------------------------------- the capture rules -- */
  /* One capture, as the classifier returns it:
       { type, text, confidence 0..1, parentId, duplicateOf, appliesTo[],
         title, fn, phase, owner, frequency, timeBand, systems, problem, claudeDoes, surface,   (opportunity)
         blockedBy {kind, ref}, answerBy, enablerOwner, module,
         evidence [{quote, speaker, at, source}] }
     applyCapture follows the extraction rules in order and returns what it
     did: { action: 'merged' | 'attached' | 'created' | 'enabler' | 'learning' | 'triaged', id, reason }.
     opts: { createdBy, origin, keys } where keys maps a model's temporary
     key for a new Opportunity ("new1") to the ID it was given. */
  function applyCapture(reg, cap, opts) {
    opts = opts || {};
    var keys = opts.keys || (opts.keys = {});
    var type = CAPTURE_TYPES.indexOf(cap.type) >= 0 ? cap.type : null;
    var conf = typeof cap.confidence === 'number' ? cap.confidence : 0;
    var ev = cleanEvidence(cap.evidence);
    var ref = function (id) { return id ? resolve(reg, keys[id] || id) : ''; };

    /* Rule 3: low confidence, or no type at all, goes to Triage. */
    if (!type || conf < THRESHOLDS.triage) return triage(reg, cap, type ? 'Low confidence (' + conf.toFixed(2) + ')' : 'No type given', opts);

    if (type === 'learning') {
      var lm = bestMatch(reg.learning, cap.text);
      if (lm.item && lm.score >= THRESHOLDS.merge) { addEvidence(lm.item, ev); return { action: 'merged', id: lm.item.id, reason: 'Same learning point' }; }
      var l = { id: nextPrefixed(reg, 'L'), text: String(cap.text || '').trim(), module: String(cap.module || ''), evidence: ev };
      reg.learning.push(l);
      return { action: 'learning', id: l.id };
    }

    /* Rule 4: an Enabler, or a Dependency or Setup action that applies to two
       or more Opportunities, is organisation-wide. Reuse one before creating. */
    var applies = (cap.appliesTo || []).map(ref).filter(function (id) { return findOpp(reg, id); });
    if (cap.parentId && findOpp(reg, ref(cap.parentId)) && applies.indexOf(ref(cap.parentId)) < 0) applies.unshift(ref(cap.parentId));
    if (type === 'enabler' || ((type === 'dependency' || type === 'setup_action') && applies.length >= 2)) {
      return toEnabler(reg, { text: cap.text, owner: cap.enablerOwner || cap.owner, links: applies, evidence: ev }, opts);
    }

    if (type === 'opportunity') {
      /* Rule 2: the same workflow again is evidence, not a second row. */
      var dup = cap.duplicateOf && findOpp(reg, ref(cap.duplicateOf));
      var m = dup ? { item: dup, score: 1 } : bestMatch(reg.opportunities, cap.title || cap.text, function (o) { return fitScore(o, cap); });
      if (m.item && m.score >= THRESHOLDS.merge) {
        addEvidence(m.item, ev); fillBlanks(m.item, cap); syncQualification(reg, m.item, opts);
        if (cap.key) keys[cap.key] = m.item.id;
        return { action: 'merged', id: m.item.id, reason: dup ? 'Model marked it a duplicate' : 'Same workflow (' + m.score.toFixed(2) + ')' };
      }
      var o = createOpportunity(reg, Object.assign({}, cap, { title: cap.title || cap.text, evidence: ev, origin: opts.origin || cap.origin }), opts);
      if (cap.key) keys[cap.key] = o.id;
      return { action: 'created', id: o.id };
    }

    /* A child. Rule 1: attach before create. The model's parent wins when it
       names a real one; otherwise the best-fitting Opportunity, if good enough. */
    var parent = findOpp(reg, ref(cap.parentId));
    if (!parent) {
      var pm = bestMatch(reg.opportunities, cap.text, function (o) { return fitScore(o, cap); });
      if (pm.item && pm.score >= THRESHOLDS.attach) parent = pm.item;
    }
    if (!parent) return triage(reg, cap, 'No parent Opportunity found', opts);

    /* Rule 4, detected in code as well: the same Dependency or Setup action
       already sitting under a different Opportunity becomes one Enabler. */
    if (type === 'dependency' || type === 'setup_action') {
      var twin = bestMatch(reg.items.filter(function (i) { return i.type === type && i.parentId !== parent.id; }), cap.text);
      if (twin.item && twin.score >= THRESHOLDS.merge) {
        var e = toEnabler(reg, { text: twin.item.text, owner: cap.enablerOwner || twin.item.owner, links: [twin.item.parentId, parent.id], evidence: twin.item.evidence.concat(ev) }, opts);
        removeItem(reg, twin.item.id, e.id);
        logChange(reg, 'lift to enabler', { from: twin.item.id, to: e.id, reason: 'Same ' + TYPE_LABELS[type].toLowerCase() + ' under ' + twin.item.parentId + ' and ' + parent.id }, opts);
        return { action: 'enabler', id: e.id, reason: 'Applies to ' + twin.item.parentId + ' and ' + parent.id };
      }
    }

    /* Rule 2 at child level. */
    var same = cap.duplicateOf && findItem(reg, ref(cap.duplicateOf));
    var cm = same ? { item: same, score: 1 } : bestMatch(childrenOf(reg, parent.id).filter(function (i) { return i.type === type && !i.auto; }), cap.text);
    if (cm.item && cm.score >= THRESHOLDS.merge) { addEvidence(cm.item, ev); return { action: 'merged', id: cm.item.id, reason: 'Same ' + TYPE_LABELS[type].toLowerCase() }; }

    var c = createChild(reg, parent.id, { type: type, text: cap.text, owner: cap.owner, blockedBy: cap.blockedBy, answerBy: cap.answerBy, evidence: ev }, opts);
    return { action: 'attached', id: c.id };
  }
  function triage(reg, cap, reason, opts) {
    var t = { id: nextPrefixed(reg, 'T'), text: String(cap.text || cap.title || '').trim(), suggestedType: cap.type || '',
      suggestedParent: cap.parentId || '', confidence: typeof cap.confidence === 'number' ? cap.confidence : 0, reason: reason,
      capture: cap, evidence: cleanEvidence(cap.evidence) };
    reg.triage.push(t);
    return { action: 'triaged', id: t.id, reason: reason };
  }
  function toEnabler(reg, f, opts) {
    var m = bestMatch(reg.enablers, f.text);
    if (m.item && m.score >= THRESHOLDS.merge) { addEvidence(m.item, f.evidence); linkEnabler(reg, m.item, f.links); return Object.assign({ action: 'enabler', id: m.item.id, reason: 'Reused an existing Enabler' }, { row: m.item }); }
    var e = createEnabler(reg, f, opts);
    return Object.assign({ action: 'enabler', id: e.id }, { row: e });
  }
  function removeItem(reg, id, aliasTo) {
    reg.items = reg.items.filter(function (i) { return i.id !== id; });
    if (aliasTo) reg.aliases[id] = aliasTo;
  }
  /* A batch from one transcript window: new Opportunities first, so children
     in the same batch can name them by their temporary key. */
  function applyCaptures(reg, caps, opts) {
    opts = Object.assign({ keys: {} }, opts || {});
    var order = (caps || []).slice().sort(function (a, b) { return (b.type === 'opportunity') - (a.type === 'opportunity'); });
    return order.map(function (c) { return Object.assign({ capture: c }, applyCapture(reg, c, opts)); });
  }

  /* ------------------------------------------------- promote and demote -- */
  function promote(reg, childId, fields, opts) {
    var c = findItem(reg, childId); if (!c) throw new Error('No child ' + childId);
    var parent = findOpp(reg, c.parentId) || {};
    var f = Object.assign({ title: c.text, fn: parent.fn, phase: parent.phase, systems: parent.systems, origin: parent.origin, confirmed: parent.confirmed }, fields || {});
    f.evidence = c.evidence;
    var o = createOpportunity(reg, f, Object.assign({ createdBy: 'manual' }, opts));
    removeItem(reg, c.id, o.id);
    logChange(reg, 'promote', { from: c.id, to: o.id, type: c.type, evidence: c.evidence.length }, opts);
    return o;
  }
  /* Fold an Opportunity into another as a child. Its evidence, children and
     Enabler links move with it; anything that pointed at it points at the
     new parent. Votes cannot be moved from here (they belong to people), so
     the log records how many there were. */
  function demote(reg, oppId, intoId, asType, opts) {
    var o = findOpp(reg, oppId), into = findOpp(reg, intoId);
    if (!o || !into) throw new Error('Demote needs two Opportunities');
    if (o.id === into.id) throw new Error('Cannot fold an Opportunity into itself');
    var type = pickEnum(asType, CHILD_TYPES, 'build_step');
    var c = createChild(reg, into.id, { type: type, text: o.title + (o.problem ? '. ' + o.problem : ''), evidence: o.evidence }, Object.assign({ createdBy: 'manual' }, opts));
    moveChildren(reg, o.id, into.id);
    carryNotes(into, o);
    reg.enablers.forEach(function (e) { var i = e.links.indexOf(o.id); if (i >= 0) { e.links.splice(i, 1); if (e.links.indexOf(into.id) < 0) e.links.push(into.id); } });
    repoint(reg, o.id, into.id);
    reg.opportunities = reg.opportunities.filter(function (x) { return x.id !== o.id; });
    reg.aliases[o.id] = c.id;
    syncQualification(reg, into, opts);
    logChange(reg, 'demote', { from: o.id, to: c.id, into: into.id, type: type, evidence: o.evidence.length, votes: o.votes || 0 }, opts);
    return c;
  }
  /* Two Opportunities that are the same workflow: keep one, carry the rest. */
  function mergeOpportunities(reg, fromId, intoId, opts) {
    var a = findOpp(reg, fromId), b = findOpp(reg, intoId);
    if (!a || !b || a.id === b.id) throw new Error('Merge needs two different Opportunities');
    addEvidence(b, a.evidence); fillBlanks(b, a); carryNotes(b, a);
    moveChildren(reg, a.id, b.id);
    reg.enablers.forEach(function (e) { var i = e.links.indexOf(a.id); if (i >= 0) { e.links.splice(i, 1); if (e.links.indexOf(b.id) < 0) e.links.push(b.id); } });
    repoint(reg, a.id, b.id);
    b.votes = (b.votes || 0) + (a.votes || 0);
    reg.opportunities = reg.opportunities.filter(function (x) { return x.id !== a.id; });
    reg.aliases[a.id] = b.id;
    syncQualification(reg, b, opts);
    logChange(reg, 'merge', { from: a.id, into: b.id, evidence: a.evidence.length }, opts);
    return b;
  }
  function moveChildren(reg, fromId, toId) {
    reg.items.filter(function (i) { return i.parentId === fromId; }).forEach(function (i) {
      if (i.auto) { reg.items = reg.items.filter(function (x) { return x !== i; }); return; }
      var same = childrenOf(reg, toId).filter(function (x) { return x.type === i.type && !x.auto && similarity(x.text, i.text) >= THRESHOLDS.merge; })[0];
      if (same) { addEvidence(same, i.evidence); removeItem(reg, i.id, same.id); return; }
      var old = i.id; i.id = nextChildId(reg, toId); i.parentId = toId; reg.aliases[old] = i.id;
    });
  }
  function repoint(reg, fromId, toId) {
    reg.items.forEach(function (i) { if (i.blockedBy && i.blockedBy.kind === 'opportunity' && resolve(reg, i.blockedBy.ref) === fromId) i.blockedBy.ref = toId; });
  }
  function moveChild(reg, childId, toParentId, opts) {
    var c = findItem(reg, childId), p = findOpp(reg, toParentId);
    if (!c || !p) throw new Error('Move needs a child and an Opportunity');
    if (c.parentId === p.id) return c;
    var old = c.id; c.id = nextChildId(reg, p.id); c.parentId = p.id; reg.aliases[old] = c.id;
    logChange(reg, 'move', { from: old, to: c.id }, opts);
    return c;
  }
  function reclassify(reg, id, toType, opts) {
    var c = findItem(reg, id); if (!c) throw new Error('No child ' + id);
    if (CHILD_TYPES.indexOf(toType) < 0) throw new Error('Not a child type: ' + toType);
    var was = c.type; c.type = toType;
    if (toType === 'dependency') { c.owner = c.owner || ''; c.blockedBy = normBlockedBy(c.blockedBy); }
    logChange(reg, 'reclassify', { id: c.id, from: was, to: toType }, opts);
    return c;
  }
  /* intoId: a Learning item this one repeats (from consolidation); otherwise
     a near-identical existing one is reused. */
  function toLearning(reg, id, module, opts, intoId) {
    var hit = findAny(reg, id); if (!hit) throw new Error('Nothing called ' + id);
    var r = hit.row, text = r.title || r.text;
    var same = intoId && reg.learning.filter(function (x) { return x.id === resolve(reg, intoId); })[0];
    var lm = bestMatch(reg.learning, text), l;
    if (same) { l = same; addEvidence(l, r.evidence); }
    else if (lm.item && lm.score >= THRESHOLDS.merge) { l = lm.item; addEvidence(l, r.evidence); }
    else { l = { id: nextPrefixed(reg, 'L'), text: text, module: String(module || ''), evidence: cleanEvidence(r.evidence) }; reg.learning.push(l); }
    dropRow(reg, hit, l.id);
    logChange(reg, 'to learning', { from: r.id, to: l.id }, opts);
    return l;
  }
  function dropRow(reg, hit, aliasTo) {
    var id = hit.row.id;
    if (hit.kind === 'opportunity') {
      reg.items.filter(function (i) { return i.parentId === id; }).forEach(function (i) { if (!i.auto) triage(reg, { type: i.type, text: i.text, confidence: 1, evidence: i.evidence }, 'Parent ' + id + ' was removed'); });
      reg.items = reg.items.filter(function (i) { return i.parentId !== id; });
      reg.opportunities = reg.opportunities.filter(function (o) { return o.id !== id; });
      reg.enablers.forEach(function (e) { e.links = e.links.filter(function (l) { return l !== id; }); });
    } else if (hit.kind === 'item') reg.items = reg.items.filter(function (i) { return i.id !== id; });
    else if (hit.kind === 'triage') reg.triage = reg.triage.filter(function (t) { return t.id !== id; });
    else if (hit.kind === 'enabler') reg.enablers = reg.enablers.filter(function (e) { return e.id !== id; });
    if (aliasTo) reg.aliases[id] = aliasTo;
  }

  /* ------------------------------------------------ session consolidation -- */
  /* The consolidation prompt returns the register as it should be: a list of
     Opportunities (existing IDs it keeps, or keys like "new1" it proposes)
     and a placement for every existing row. planChanges turns that into a
     list of single, reviewable changes against the register as it is. Each
     change can be approved or rejected on its own; a change that needs an
     earlier one (a child going under a proposed new Opportunity) names it in
     `requires`, and is skipped if that one is rejected. */
  function planChanges(reg, proposal) {
    var changes = [], n = 0, keyChange = {};
    var add = function (c) { c.id = 'C' + (++n); changes.push(c); return c; };
    var oppKeys = {};
    (proposal.opportunities || []).forEach(function (p) {
      if (p.key && findOpp(reg, p.key)) {
        oppKeys[p.key] = p.key;
        var o = findOpp(reg, p.key);
        if (p.title && norm(p.title) !== norm(o.title)) add({ kind: 'retitle', target: o.id, title: p.title, reason: 'Clearer workflow name (verb plus object)' });
        /* Fields the row is missing and the model can now fill: owner,
           trigger, time per round and the rest. Blanks only, never overwrites. */
        var fill = {};
        QUALIFY_FIELDS.forEach(function (k) {
          var v = k === 'fn' ? (p.fn || p['function']) : p[k];
          var has = k === 'systems' ? (o.systems || []).length : String(o[k] || '').trim();
          if (!has && v && (!Array.isArray(v) || v.length) && (k !== 'timeBand' || TIME_BANDS.indexOf(v) >= 0)) fill[k] = v;
        });
        if (Object.keys(fill).length) add({ kind: 'qualify', target: o.id, fields: fill, reason: 'Fills what the row was missing' });
      } else if (p.key) {
        var c = add({ kind: 'create', key: p.key, fields: p, reason: p.reason || 'Groups rows that describe one workflow' });
        keyChange[p.key] = c.id;
      }
    });
    var target = function (k) { return keyChange[k] ? k : (findOpp(reg, k) ? resolve(reg, k) : ''); };
    var req = function (k) { return keyChange[k] ? [keyChange[k]] : []; };

    /* Duplicates are merged after every row has its place. In a migration every
       row starts as an Opportunity, so a repeated step is usually two demoted
       rows: the merge names both demotes in `requires`. stepOf maps a row to
       the change that places it; finals holds each child's final parent, type
       and wording for the similarity check below. */
    var placedAs = {}, stepOf = {}, finals = [], later = [], root = {};
    var find = function (id) { while (root[id]) id = root[id]; return id; };
    var join = function (a, b) { a = find(a); b = find(b); if (a !== b) root[a] = b; return a !== b; };
    (proposal.placements || []).forEach(function (pl) {
      var ok = (typeof pl.confidence === 'number' ? pl.confidence : 1) >= THRESHOLDS.triage;
      placedAs[pl.id] = ok ? pl.type : 'triage';
    });
    var dupTarget = function (pl, types) {
      var d = pl.duplicateOf;
      return d && d !== pl.id && (types.indexOf(placedAs[d]) >= 0 || (!placedAs[d] && findAny(reg, d))) ? d : '';
    };

    (proposal.placements || []).forEach(function (pl) {
      var hit = findAny(reg, pl.id); if (!hit) return;
      var why = pl.reason || '';
      var conf = typeof pl.confidence === 'number' ? pl.confidence : 1;
      if (conf < THRESHOLDS.triage && hit.kind !== 'triage') { add({ kind: 'triage', target: hit.row.id, reason: why || 'Classifier was not sure (' + conf.toFixed(2) + ')' }); return; }
      if (pl.type === 'learning') {
        if (hit.kind === 'learning') return;
        var same = dupTarget(pl, ['learning']);
        if (same) later.push({ kind: 'learning', target: hit.row.id, module: pl.module || '', into: same, reason: why || 'Same point as ' + same });
        else stepOf[hit.row.id] = add({ kind: 'learning', target: hit.row.id, module: pl.module || '', reason: why }).id;
        return;
      }
      if (pl.type === 'enabler') return; /* enablers are listed separately below */
      if (pl.type === 'opportunity') {
        if (hit.kind === 'opportunity') {
          var into = pl.duplicateOf && target(pl.duplicateOf);
          if (into && into !== hit.row.id) add({ kind: 'merge', target: hit.row.id, into: into, requires: req(pl.duplicateOf), reason: why || 'Same workflow' });
          else if (pl.parent && target(pl.parent) && target(pl.parent) !== hit.row.id && !findOpp(reg, pl.parent)) add({ kind: 'merge', target: hit.row.id, into: pl.parent, requires: req(pl.parent), reason: why || 'Same workflow' });
        } else if (hit.kind === 'item' || hit.kind === 'triage') {
          add({ kind: 'promote', target: hit.row.id, key: pl.parent && keyChange[pl.parent] ? pl.parent : '', requires: req(pl.parent), reason: why || 'A workflow in its own right' });
        }
        return;
      }
      if (CHILD_TYPES.indexOf(pl.type) < 0) return;
      var parent = target(pl.parent);
      if (!parent) { if (hit.kind !== 'triage') add({ kind: 'triage', target: hit.row.id, reason: 'No parent given' }); return; }
      var dupOf = pl.duplicateOf && findItem(reg, pl.duplicateOf) ? resolve(reg, pl.duplicateOf) : '';
      var fin = { id: hit.row.id, parent: parent, type: pl.type, text: pl.text || hit.row.text || hit.row.title };
      if (hit.kind === 'opportunity') {
        stepOf[hit.row.id] = add({ kind: 'demote', target: hit.row.id, into: parent, asType: pl.type, text: pl.text || '', requires: req(pl.parent), reason: why || 'A step inside a bigger workflow, not a workflow' }).id;
        var dupRow = dupTarget(pl, CHILD_TYPES);
        if (dupRow) later.push({ kind: 'merge', target: hit.row.id, into: dupRow, reason: why || 'Same item as ' + dupRow });
      } else if (hit.kind === 'item') {
        if (dupOf && dupOf !== hit.row.id) { join(hit.row.id, dupOf); add({ kind: 'merge', target: hit.row.id, into: dupOf, reason: why || 'Same item' }); return; }
        if (parent !== hit.row.parentId) add({ kind: 'move', target: hit.row.id, into: parent, requires: req(pl.parent), reason: why });
        if (pl.type !== hit.row.type) add({ kind: 'reclassify', target: hit.row.id, toType: pl.type, reason: why });
      } else if (hit.kind === 'triage') {
        stepOf[hit.row.id] = add({ kind: 'attach', target: hit.row.id, into: parent, asType: pl.type, requires: req(pl.parent), reason: why }).id;
      }
      finals.push(fin);
    });

    /* Model-marked duplicates first, then a safety net: two children under the
       same parent, of the same type, worded alike (THRESHOLDS.merge) are one
       item. Both become reviewable merges, never silent ones. A merge chain or
       loop collapses to one survivor. */
    /* Learning repeats: one survivor per group (a row placed plainly if there
       is one), converted first, then the rest folded into it. */
    var learn = later.filter(function (c) { return c.kind === 'learning'; });
    learn.forEach(function (c) { join(c.target, c.into); });
    var groups = {};
    learn.forEach(function (c) { [c.target, c.into].forEach(function (id) { var g = groups[find(id)] = groups[find(id)] || []; if (g.indexOf(id) < 0) g.push(id); }); });
    var repeat = {}; learn.forEach(function (c) { repeat[c.target] = c; });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k], keep = g.filter(function (id) { return !repeat[id]; })[0] || g[0];
      if (repeat[keep]) { var r = repeat[keep]; stepOf[keep] = add({ kind: 'learning', target: keep, module: r.module, reason: r.reason }).id; }
      g.forEach(function (id) {
        if (id === keep || !repeat[id]) return;
        var c = repeat[id];
        stepOf[id] = add({ kind: 'learning', target: id, module: c.module, into: keep, requires: [stepOf[keep]].filter(Boolean), reason: c.reason }).id;
      });
    });
    later.filter(function (c) { return c.kind === 'merge'; }).forEach(function (c) {
      if (!stepOf[c.into] && !findItem(reg, c.into)) return;
      if (!join(c.target, c.into)) return;
      c.requires = [stepOf[c.target], stepOf[c.into]].filter(Boolean);
      add(c);
    });
    finals.forEach(function (a, i) {
      finals.slice(i + 1).forEach(function (b) {
        if (a.parent !== b.parent || a.type !== b.type || find(a.id) === find(b.id)) return;
        var s = similarity(a.text, b.text); if (s < THRESHOLDS.merge) return;
        join(b.id, a.id);
        add({ kind: 'merge', target: b.id, into: a.id, requires: [stepOf[b.id], stepOf[a.id]].filter(Boolean),
          reason: 'Worded almost the same as ' + a.id + ' under the same Opportunity (similarity ' + s.toFixed(2) + ')' });
      });
    });

    (proposal.enablers || []).forEach(function (en) {
      var links = (en.links || []).filter(function (l) { return target(l); });
      var existing = en.key && findEnabler(reg, en.key);
      if (existing) {
        var newLinks = links.filter(function (l) { return existing.links.indexOf(target(l)) < 0; });
        if (newLinks.length) add({ kind: 'link', target: existing.id, links: newLinks, requires: [].concat.apply([], newLinks.map(req)), reason: en.reason || '' });
        return;
      }
      add({ kind: 'enabler', text: en.text, owner: en.owner, links: links, from: (en.fromIds || []).filter(function (i) { return findAny(reg, i); }),
        requires: [].concat.apply([], links.map(req)), reason: en.reason || 'Applies to more than one Opportunity' });
    });
    return changes;
  }

  /* Human-readable before and after for one change, for the review screen. */
  function describe(reg, c) {
    var name = function (id) {
      var h = findAny(reg, id); if (!h) return id;
      return h.row.id + ' ' + (h.row.title || h.row.text) + (h.kind === 'item' ? ' (' + TYPE_LABELS[h.row.type] + ' under ' + h.row.parentId + ')' : h.kind === 'opportunity' ? ' (Opportunity)' : ' (' + h.kind + ')');
    };
    var oppName = function (k) { var o = findOpp(reg, k); return o ? o.id + ' ' + o.title : 'new Opportunity ' + k; };
    switch (c.kind) {
      case 'create': return { before: '(nothing)', after: 'New Opportunity: ' + c.fields.title };
      case 'retitle': return { before: name(c.target), after: c.title };
      case 'qualify': return { before: name(c.target), after: Object.keys(c.fields).map(function (k) { return FIELD_LABELS[k] + ': ' + (Array.isArray(c.fields[k]) ? c.fields[k].join(', ') : c.fields[k]); }).join('; ') };
      case 'merge': return { before: name(c.target), after: 'Merged into ' + (findAny(reg, c.into) ? name(c.into) : oppName(c.into)) + ', evidence kept' };
      case 'demote': return { before: name(c.target), after: TYPE_LABELS[c.asType] + ' under ' + oppName(c.into) };
      case 'promote': return { before: name(c.target), after: 'Opportunity in its own right' };
      case 'move': return { before: name(c.target), after: 'Moved under ' + oppName(c.into) };
      case 'reclassify': return { before: name(c.target), after: TYPE_LABELS[c.toType] };
      case 'attach': return { before: name(c.target), after: TYPE_LABELS[c.asType] + ' under ' + oppName(c.into) };
      case 'learning': return { before: name(c.target), after: 'Learning backlog' + (c.into ? ', same point as ' + name(c.into) : '') };
      case 'triage': return { before: name(c.target), after: 'Triage' };
      case 'enabler': return { before: (c.from || []).map(name).join('; ') || '(nothing)', after: 'Enabler: ' + c.text + ', blocks ' + c.links.map(oppName).join(', ') };
      case 'link': return { before: name(c.target), after: 'Also blocks ' + c.links.map(oppName).join(', ') };
    }
    return { before: '', after: '' };
  }

  /* Apply the approved changes, in order, to a copy. decisions maps change
     ID to true (approve) or false (reject); anything missing is rejected, so
     nothing is ever applied silently. Returns the new register and what
     happened to each change. */
  function applyChanges(reg, changes, decisions, opts) {
    var out = clone(reg), keys = {}, results = [];
    opts = Object.assign({ by: 'facilitator' }, opts || {});
    var done = {};
    var tgt = function (k) { return keys[k] || resolve(out, k); };
    changes.forEach(function (c) {
      if (decisions[c.id] !== true) { results.push({ id: c.id, status: 'rejected' }); return; }
      var missing = (c.requires || []).filter(function (r) { return !done[r]; });
      if (missing.length) { results.push({ id: c.id, status: 'skipped', reason: 'Needs ' + missing.join(', ') }); return; }
      try {
        switch (c.kind) {
          case 'create': {
            var o = createOpportunity(out, Object.assign({}, c.fields, { evidence: c.fields.evidence || [] }), Object.assign({ createdBy: 'migration' }, opts, { createdBy: opts.createdBy || 'manual' }));
            keys[c.key] = o.id; logChange(out, 'create', { id: o.id, change: c.id }, opts); break;
          }
          case 'qualify': { var q = findOpp(out, c.target); fillBlanks(q, c.fields); syncQualification(out, q, opts); logChange(out, 'qualify', { id: q.id, fields: Object.keys(c.fields) }, opts); break; }
          case 'retitle': { var r = findOpp(out, c.target); logChange(out, 'retitle', { id: r.id, from: r.title, to: c.title }, opts); r.title = c.title; break; }
          case 'merge': {
            var h = findAny(out, c.target);
            if (!h) throw new Error(c.target + ' is gone');
            if (h.kind === 'opportunity') mergeOpportunities(out, h.row.id, tgt(c.into), opts);
            else {
              var into = findItem(out, tgt(c.into));
              if (!into) throw new Error(c.into + ' is not a child item');
              if (into.id === h.row.id) break;
              addEvidence(into, h.row.evidence); removeItem(out, h.row.id, into.id); logChange(out, 'merge', { from: h.row.id, into: into.id }, opts);
            }
            break;
          }
          case 'demote': { var ch = demote(out, c.target, tgt(c.into), c.asType, opts); if (c.text) ch.text = c.text; break; }
          case 'promote': { var p = promote(out, c.target, null, opts); if (c.key) keys[c.key] = p.id; break; }
          case 'move': moveChild(out, c.target, tgt(c.into), opts); break;
          case 'reclassify': reclassify(out, c.target, c.toType, opts); break;
          case 'attach': {
            var t = out.triage.filter(function (x) { return x.id === resolve(out, c.target); })[0];
            var child = createChild(out, tgt(c.into), { type: c.asType, text: t.text, evidence: t.evidence }, opts);
            dropRow(out, { kind: 'triage', row: t }, child.id); logChange(out, 'attach', { from: t.id, to: child.id }, opts); break;
          }
          case 'learning': toLearning(out, c.target, c.module, opts, c.into ? tgt(c.into) : ''); break;
          case 'triage': {
            var th = findAny(out, c.target);
            var tr = triage(out, { type: th.kind === 'item' ? th.row.type : 'opportunity', text: th.row.title || th.row.text, confidence: 0, evidence: th.row.evidence }, c.reason || 'Sent to triage', opts);
            dropRow(out, th, tr.id); logChange(out, 'to triage', { from: th.row.id, to: tr.id }, opts); break;
          }
          case 'enabler': {
            var ev = [];
            (c.from || []).forEach(function (id) { var fh = findAny(out, id); if (fh) ev = ev.concat(fh.row.evidence || []); });
            var e = toEnabler(out, { text: c.text, owner: c.owner, links: c.links.map(tgt), evidence: ev }, opts).row;
            (c.from || []).forEach(function (id) { var fh = findAny(out, id); if (fh && fh.row.id !== e.id) dropRow(out, fh, e.id); });
            logChange(out, 'enabler', { id: e.id, links: e.links.slice(), from: c.from || [] }, opts); break;
          }
          case 'link': { var en = findEnabler(out, c.target); linkEnabler(out, en, c.links.map(tgt)); logChange(out, 'link', { id: en.id, links: en.links.slice() }, opts); break; }
          default: throw new Error('Unknown change ' + c.kind);
        }
        done[c.id] = true; results.push({ id: c.id, status: 'applied' });
      } catch (e) {
        results.push({ id: c.id, status: 'failed', reason: String(e.message || e) });
      }
    });
    return { register: out, results: results };
  }

  /* ----------------------------------------------------------- summaries -- */
  function summary(reg) {
    var s = { opportunities: reg.opportunities.length, counted: countedOpportunities(reg).length, blocked: 0,
      enablers: reg.enablers.length, learning: reg.learning.length, triage: reg.triage.length, children: 0 };
    CHILD_TYPES.forEach(function (t) { s[t] = 0; });
    reg.items.forEach(function (i) { s[i.type]++; s.children++; });
    reg.opportunities.forEach(function (o) { if (isBlocked(reg, o.id)) s.blocked++; });
    return s;
  }

  return {
    CHILD_TYPES: CHILD_TYPES, CAPTURE_TYPES: CAPTURE_TYPES, TYPE_LABELS: TYPE_LABELS, STATUSES: STATUSES, ITEM_STATUSES: ITEM_STATUSES,
    ORIGINS: ORIGINS, TIME_BANDS: TIME_BANDS, ENABLER_OWNERS: ENABLER_OWNERS, UNIT_FIELDS: UNIT_FIELDS, THRESHOLDS: THRESHOLDS,
    norm: norm, similarity: similarity, fitScore: fitScore,
    empty: empty, clone: clone, resolve: resolve, findOpp: findOpp, findItem: findItem, findEnabler: findEnabler, findAny: findAny,
    childrenOf: childrenOf, childCounts: childCounts, missingUnitFields: missingUnitFields, needsQualification: needsQualification, syncQualification: syncQualification,
    blockers: blockers, isBlocked: isBlocked, displayStatus: displayStatus, counts: counts, countedOpportunities: countedOpportunities,
    suggestEase: suggestEase, warnings: warnings, summary: summary,
    createOpportunity: createOpportunity, createChild: createChild, createEnabler: createEnabler, addEvidence: addEvidence,
    applyCapture: applyCapture, applyCaptures: applyCaptures,
    promote: promote, demote: demote, mergeOpportunities: mergeOpportunities, moveChild: moveChild, reclassify: reclassify, toLearning: toLearning,
    planChanges: planChanges, describe: describe, applyChanges: applyChanges
  };
});
