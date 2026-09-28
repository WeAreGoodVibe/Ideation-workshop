/* ============================================================================
   lib/pipeline.js: between the register and the model.

   Builds the prompts from the versioned files in prompts/, holds the JSON
   schemas the model must answer in (defined once, used by the page and by
   api/extract.js), and turns a reply into captures or into reviewable
   changes. Talking to the model is not done here: callers pass an `ask`
   function, so the page, the server and the Node scripts share every rule.

   Loaded as window.PIPE in the browser (after lib/register.js) and with
   require() in Node.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./register.js'));
  else root.PIPE = factory(root.REG);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  /* ------------------------------------------------------------ schemas -- */
  var S = function (props) { return { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props }; };
  var str = { type: 'string' }, strs = { type: 'array', items: { type: 'string' } };
  var en = function (list) { return { type: 'string', enum: list }; };

  function captureItem(functions) {
    return S({
      type: en(R.CAPTURE_TYPES), key: str, text: str, confidence: { type: 'number' },
      parentId: str, duplicateOf: str, appliesTo: strs,
      title: str, 'function': en((functions || []).concat([''])), phase: str, owner: str, frequency: str,
      timeBand: en(R.TIME_BANDS.concat([''])), systems: strs, problem: str, claudeDoes: str, surface: str,
      blockedByKind: en(['opportunity', 'enabler', 'external', '']), blockedByRef: str, answerBy: str,
      enablerOwner: en(R.ENABLER_OWNERS.concat([''])), module: str,
      quote: str, speaker: str, at: str, why: str, comparator: str
    });
  }
  function captureSchema(functions) {
    return S({
      captures: { type: 'array', items: captureItem(functions) },
      systems: { type: 'array', items: S({ name: str, category: str, usedBy: str, note: str }) },
      phases: { type: 'array', items: S({ name: str, 'function': en(functions && functions.length ? functions : ['']), what: str }) }
    });
  }
  function consolidateSchema(functions) {
    return S({
      opportunities: { type: 'array', items: S({
        key: str, title: str, 'function': en((functions || []).concat([''])), phase: str, owner: str, frequency: str,
        timeBand: en(R.TIME_BANDS.concat([''])), systems: strs, problem: str, claudeDoes: str, surface: str,
        origin: en(R.ORIGINS), reason: str }) },
      placements: { type: 'array', items: S({
        id: str, type: en(R.CAPTURE_TYPES), parent: str, duplicateOf: str, text: str, module: str,
        confidence: { type: 'number' }, reason: str }) },
      enablers: { type: 'array', items: S({ key: str, text: str, owner: en(R.ENABLER_OWNERS), links: strs, fromIds: strs, reason: str }) }
    });
  }

  /* ---------------------------------------------------------- templates -- */
  function render(template, vars) {
    return String(template).replace(/^<!--[\s\S]*?-->\s*/, '').replace(/\{\{(\w+)\}\}/g, function (m, k) { return vars[k] == null ? '' : String(vars[k]); });
  }
  var cut = function (s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  /* The register as the model sees it: a tree with IDs, so it can attach. */
  function registerDigest(reg) {
    if (!reg.opportunities.length && !reg.enablers.length) return '(empty: nothing captured yet)';
    var lines = [];
    reg.opportunities.forEach(function (o) {
      lines.push(o.id + ' ' + o.title + ' | phase: ' + (o.phase || '?') + ' | owner: ' + (o.owner || '?') + ' | trigger: ' + (o.frequency || '?') +
        ' | systems: ' + ((o.systems || []).join(', ') || '?') + (o.origin === 'Proposed' ? ' | Proposed' : ''));
      R.childrenOf(reg, o.id).filter(function (i) { return !i.auto; }).forEach(function (i) {
        lines.push('  ' + i.id + ' [' + R.TYPE_LABELS[i.type] + '] ' + cut(i.text, 120));
      });
    });
    if (reg.enablers.length) {
      lines.push('ENABLERS (organisation-wide)');
      reg.enablers.forEach(function (e) { lines.push('  ' + e.id + ' ' + cut(e.text, 120) + ' | blocks ' + e.links.join(', ') + ' | ' + e.status); });
    }
    return lines.join('\n');
  }
  /* Every row, flat, for consolidation. Triage rows are included so the
     model can place them too. */
  function registerRows(reg) {
    var q = function (r) { return (r.evidence || []).slice(0, 2).map(function (e) { return '"' + cut(e.quote, 90) + '"' + (e.speaker ? ' ' + e.speaker : ''); }).join('; '); };
    var rows = [];
    reg.opportunities.forEach(function (o) {
      rows.push([o.id, 'opportunity', '', cut(o.title, 140), o.phase, o.owner, (o.systems || []).join(', '), cut(o.problem, 160), cut(o.claudeDoes, 160), q(o)].join(' | '));
    });
    reg.items.filter(function (i) { return !i.auto; }).forEach(function (i) { rows.push([i.id, i.type, i.parentId, cut(i.text, 160), '', i.owner || '', '', '', '', q(i)].join(' | ')); });
    reg.enablers.forEach(function (e) { rows.push([e.id, 'enabler', '', cut(e.text, 160), '', e.owner, '', '', '', q(e)].join(' | ')); });
    reg.triage.forEach(function (t) { rows.push([t.id, 'unclassified', '', cut(t.text, 160), '', '', '', '', '', q(t)].join(' | ')); });
    return rows;
  }

  function extractPrompt(template, v) { return render(template, { context: v.context, register: registerDigest(v.register), window: v.window }); }
  function secondPrompt(template, v) { return render(template, { context: v.context, register: registerDigest(v.register), transcript: v.transcript }); }
  function consolidatePrompt(template, v) {
    var rows = registerRows(v.register);
    return render(template, { context: v.context || '', rows: rows.join('\n'), count: rows.length });
  }

  /* ------------------------------------------------------------ replies -- */
  /* A flat capture from the model into the shape lib/register.js applies. */
  function toCapture(c, source) {
    var ev = c.quote ? [{ quote: c.quote, speaker: c.speaker || '', at: c.at || '', source: source || 'live' }] : [];
    return {
      type: c.type, key: c.key || '', text: c.text || c.title || '', confidence: typeof c.confidence === 'number' ? c.confidence : Number(c.confidence) || 0,
      parentId: c.parentId || '', duplicateOf: c.duplicateOf || '', appliesTo: c.appliesTo || [],
      title: c.title || '', fn: c['function'] || c.fn || '', phase: c.phase || '', owner: c.owner || '', frequency: c.frequency || '',
      timeBand: c.timeBand || '', systems: c.systems || [], problem: c.problem || '', claudeDoes: c.claudeDoes || '', surface: c.surface || '',
      blockedBy: c.blockedByKind ? { kind: c.blockedByKind, ref: c.blockedByRef || '' } : null, answerBy: c.answerBy || '',
      enablerOwner: c.enablerOwner || '', module: c.module || '', why: c.why || '', comparator: c.comparator || '', evidence: ev
    };
  }
  function applyReply(reg, reply, opts) {
    opts = opts || {};
    var caps = ((reply && reply.captures) || []).map(function (c) { return toCapture(c, opts.source); });
    return R.applyCaptures(reg, caps, opts);
  }

  /* Consolidation: ask once, plan the changes, return them for review. The
     model must place every row; any it leaves out are reported, not guessed. */
  function consolidate(reg, template, ask, v) {
    var prompt = consolidatePrompt(template, { register: reg, context: (v && v.context) || '' });
    return Promise.resolve(ask(prompt, 'consolidate')).then(function (proposal) {
      var placed = {}; (proposal.placements || []).forEach(function (p) { placed[p.id] = true; });
      var expected = registerRows(reg).map(function (r) { return r.split(' | ')[0]; });
      var unplaced = expected.filter(function (id) { return !placed[id]; });
      return { proposal: proposal, changes: R.planChanges(reg, proposal), unplaced: unplaced, promptChars: prompt.length };
    });
  }

  /* --------------------------------------------------------- flat import -- */
  /* A row from an old flat export (the Opportunity Register tab) into a
     register row. Every old row becomes an Opportunity; consolidation then
     decides what it really is. Nothing is dropped. */
  function flatRowsToRegister(rows) {
    /* Merged rows come in as live rows: consolidation folds them properly,
       with their evidence, instead of the old label that folded nothing. */
    var reg = R.empty(), statusMap = { Open: 'Identified', Emerging: 'Identified', Validated: 'Qualified', Parked: 'Parked', Merged: 'Identified' };
    (rows || []).forEach(function (r) {
      var quote = r['Source quote'] || r.quote || '';
      R.createOpportunity(reg, {
        id: r.ID || r.id, title: r.Opportunity || r.title || '', fn: r.Function || r.fn || '', phase: r['Process phase'] || r.phase || '',
        owner: r.Owner || r.owner || '', systems: r.Systems || r.systems || '', problem: r['Problem / pain'] || r.pain || '',
        claudeDoes: r['What Claude does'] || r.direction || '', surface: r['Claude surface'] || r.surface || '',
        status: statusMap[r.Status || r.status] || 'Identified',
        origin: /consultant|claude/i.test(String(r.Source || r.source || '')) ? 'Proposed' : 'Client-raised',
        value: numOrNull(r['Value (client 1-5)']), ease: numOrNull(r['Ease (consultant 1-5)']), votes: Number(r.Votes || r.votes || 0) || 0,
        evidence: quote ? [{ quote: quote, speaker: r['Raised by'] || r.raisedBy || '', at: r.Captured || '', source: 'migration' }] : []
      }, { createdBy: 'migration' });
      if (r._from) reg.opportunities[reg.opportunities.length - 1].legacyRef = r._from;
    });
    /* Old rows carry no owner, trigger or time, so every one would raise
       three Open questions; those only make sense after consolidation. */
    reg.items = []; reg.opportunities.forEach(function (o) { delete o.needsQualification; });
    return reg;
  }
  function numOrNull(v) { var n = parseInt(v, 10); return n >= 1 && n <= 5 ? n : null; }

  /* Is export A contained in export B? True when every row of A appears in B
     by normalised title. Used to spot an earlier export of the same board. */
  function isSubsetExport(a, b) {
    var inB = {}; b.forEach(function (r) { inB[R.norm(r.Opportunity || r.title)] = true; });
    return a.length > 0 && a.every(function (r) { return inB[R.norm(r.Opportunity || r.title)]; });
  }
  /* Rows from several exports, without repeats. An export for a different
     client from the rest is set aside, never mixed in (the client comes from
     the workbook's Read Me tab; the client with the most rows wins). Then an
     export wholly contained in another is dropped, and identical titles are
     kept once. */
  function combineExports(exports) {
    var rowsBy = {};
    exports.forEach(function (e) { if (e.client) rowsBy[e.client] = (rowsBy[e.client] || 0) + e.rows.length; });
    var main = Object.keys(rowsBy).sort(function (a, b) { return rowsBy[b] - rowsBy[a]; })[0] || '';
    var otherClient = exports.filter(function (e) { return main && e.client && e.client !== main; });
    var same = exports.filter(function (e) { return otherClient.indexOf(e) < 0; });
    var kept = same.filter(function (e, i) {
      return !same.some(function (o, j) { return j !== i && isSubsetExport(e.rows, o.rows) && (o.rows.length > e.rows.length || j > i); });
    });
    var dropped = same.filter(function (e) { return kept.indexOf(e) < 0; }).map(function (e) { return e.name; });
    var seen = {}, rows = [], repeats = 0;
    kept.forEach(function (e) {
      e.rows.forEach(function (r) {
        var k = R.norm(r.Opportunity || r.title);
        if (seen[k]) { repeats++; return; }
        seen[k] = true; rows.push(r);
      });
    });
    return { rows: rows, client: main, subsets: dropped, otherClient: otherClient.map(function (e) { return { name: e.name, client: e.client, rows: e.rows.length }; }),
      exactRepeats: repeats, raw: kept.reduce(function (n, e) { return n + e.rows.length; }, 0) };
  }

  return {
    captureSchema: captureSchema, consolidateSchema: consolidateSchema, render: render,
    registerDigest: registerDigest, registerRows: registerRows,
    extractPrompt: extractPrompt, secondPrompt: secondPrompt, consolidatePrompt: consolidatePrompt,
    toCapture: toCapture, applyReply: applyReply, consolidate: consolidate,
    flatRowsToRegister: flatRowsToRegister, isSubsetExport: isSubsetExport, combineExports: combineExports
  };
});
