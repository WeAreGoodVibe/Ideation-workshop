/* ============================================================================
   lib/store.js: the register to and from database rows.

   fromRows builds a lib/register.js register from the Supabase tables.
   diff compares two registers and returns the writes that turn the first
   into the second, in an order that is safe to run one by one: new parents
   before their children, children moved before an old parent is deleted (the
   database would otherwise cascade them away), votes moved before a merged
   Opportunity goes, deletes last.

   Pure, like lib/register.js: sb.js runs the writes. Loaded as window.STORE
   in the browser and with require() in Node.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./register.js'));
  else root.STORE = factory(root.REG);
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  var num = function (id) { var m = /^[A-Z](\d+)$/.exec(id || ''); return m ? parseInt(m[1], 10) : 0; };
  var childNum = function (id) { var m = /\.(\d+)$/.exec(id || ''); return m ? parseInt(m[1], 10) : 0; };
  var ev = function (v) { return Array.isArray(v) ? v : []; };

  /* rows: { opportunities, register_items, enablers, enabler_links, learning_items,
     triage_items, register_aliases, register_log, tallies } straight from Supabase. */
  function fromRows(rows) {
    var reg = R.empty(), byUid = {};
    (rows.opportunities || []).forEach(function (o) {
      var t = (rows.tallies || {})[o.id] || {};
      var row = {
        id: 'O' + o.seq, uid: o.id, title: o.title, fn: o.fn || '', phase: o.phase || '', owner: o.owner || '',
        frequency: o.frequency || '', timeBand: o.time_band || '', systems: o.systems || [], problem: o.pain || '', claudeDoes: o.direction || '', notes: o.notes || '',
        surface: o.surface || '', status: o.status, origin: o.origin || 'Client-raised', confirmed: o.confirmed !== false,
        value: o.value, ease: o.ease, votes: t.total || 0, voters: t.names || [],
        evidence: ev(o.evidence).length ? ev(o.evidence) : (o.quote ? [{ quote: o.quote, speaker: o.raised_by || '', at: '', source: 'live' }] : []),
        createdBy: o.created_via || 'live', legacyRef: o.legacy_ref || '', source: o.source || '', createdByUser: o.created_by
      };
      row.needsQualification = R.needsQualification(row);
      reg.opportunities.push(row); byUid[o.id] = row.id;
    });
    (rows.register_items || []).forEach(function (i) {
      var p = byUid[i.opportunity_id]; if (!p) return;
      var row = { id: p + '.' + i.seq, uid: i.id, parentId: p, type: i.type, text: i.text, status: i.status, evidence: ev(i.evidence), createdBy: i.created_via };
      if (i.type === 'dependency') { row.owner = i.owner || ''; row.blockedBy = { kind: i.blocked_by_kind || 'external', ref: i.blocked_by_ref || '' }; }
      if (i.type === 'open_question') row.answerBy = i.answer_by || '';
      if (i.auto) row.auto = i.auto;
      reg.items.push(row);
    });
    var enByUid = {};
    (rows.enablers || []).forEach(function (e) {
      var row = { id: 'E' + e.seq, uid: e.id, text: e.text, owner: e.owner, status: e.status, links: [], evidence: ev(e.evidence), createdBy: e.created_via };
      reg.enablers.push(row); enByUid[e.id] = row;
    });
    (rows.enabler_links || []).forEach(function (l) { var e = enByUid[l.enabler_id], o = byUid[l.opportunity_id]; if (e && o) e.links.push(o); });
    (rows.learning_items || []).forEach(function (l) { reg.learning.push({ id: 'L' + l.seq, uid: l.id, text: l.text, module: l.module || '', evidence: ev(l.evidence) }); });
    (rows.triage_items || []).forEach(function (t) {
      reg.triage.push({ id: 'T' + t.seq, uid: t.id, text: t.text, suggestedType: t.suggested_type || '', suggestedParent: t.suggested_parent || '',
        confidence: Number(t.confidence) || 0, reason: t.reason || '', capture: t.capture || {}, evidence: ev(t.evidence) });
    });
    (rows.register_aliases || []).forEach(function (a) { reg.aliases[a.old_ref] = a.new_ref; });
    reg.log = (rows.register_log || []).map(function (l) { return { at: l.at, action: l.action, by: l.by_user || '', detail: l.detail || {} }; });
    reg.opportunities.forEach(function (o) { o.needsQualification = R.needsQualification(o); });
    return reg;
  }

  /* Rows as they are written. `ref` fields name another row by register ID;
     sb.js turns them into database IDs once the row they name exists. */
  function oppRow(o) {
    return { seq: num(o.id), title: o.title, fn: o.fn || 'Both', phase: o.phase || '', owner: o.owner || '', frequency: o.frequency || '',
      time_band: o.timeBand || '', systems: o.systems || [], pain: o.problem || '', direction: o.claudeDoes || '', notes: o.notes || '', surface: o.surface || '',
      status: o.status, origin: o.origin || 'Client-raised', confirmed: o.confirmed !== false, value: o.value == null ? null : o.value,
      ease: o.ease == null ? null : o.ease, evidence: ev(o.evidence), created_via: o.createdBy || 'live', legacy_ref: o.legacyRef || '',
      /* the flat board still reads these two */
      quote: (ev(o.evidence)[0] || {}).quote || '', raised_by: (ev(o.evidence)[0] || {}).speaker || 'Room' };
  }
  function itemRow(i) {
    return { seq: childNum(i.id), opportunity_ref: i.parentId, type: i.type, text: i.text, status: i.status || 'Open',
      owner: i.owner || '', blocked_by_kind: i.blockedBy ? i.blockedBy.kind : '', blocked_by_ref: i.blockedBy ? i.blockedBy.ref : '',
      answer_by: i.answerBy || '', evidence: ev(i.evidence), created_via: i.createdBy || 'live', auto: i.auto || '' };
  }
  function enablerRow(e) { return { seq: num(e.id), text: e.text, owner: e.owner, status: e.status, evidence: ev(e.evidence), created_via: e.createdBy || 'live' }; }
  function learningRow(l) { return { seq: num(l.id), text: l.text, module: l.module || '', evidence: ev(l.evidence) }; }
  function triageRow(t) {
    return { seq: num(t.id), text: t.text, suggested_type: t.suggestedType || '', suggested_parent: t.suggestedParent || '', confidence: t.confidence || 0,
      reason: t.reason || '', capture: t.capture || {}, evidence: ev(t.evidence) };
  }
  var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  var changed = function (a, b) { var p = {}; Object.keys(b).forEach(function (k) { if (!same(a[k], b[k])) p[k] = b[k]; }); return p; };
  var byUidMap = function (list) { var m = {}; list.forEach(function (x) { if (x.uid) m[x.uid] = x; }); return m; };

  /* The writes that turn `before` into `after`. Each op is
     { table, op: 'insert' | 'update' | 'delete' | 'moveVotes' | 'link' | 'unlink', ... }. */
  function diff(before, after) {
    var ops = [];
    function rows(table, list, rowFn, prev) {
      var old = byUidMap(prev), keep = {};
      list.forEach(function (x) {
        if (x.uid && old[x.uid]) {
          keep[x.uid] = true;
          var p = changed(rowFn(old[x.uid]), rowFn(x));
          if (Object.keys(p).length) ops.push({ table: table, op: 'update', uid: x.uid, id: x.id, row: p });
        } else ops.push({ table: table, op: 'insert', id: x.id, row: rowFn(x) });
      });
      return prev.filter(function (x) { return x.uid && !keep[x.uid]; });
    }
    var goneOpps = rows('opportunities', after.opportunities, oppRow, before.opportunities);
    var goneItems = rows('register_items', after.items, itemRow, before.items);
    var goneEn = rows('enablers', after.enablers, enablerRow, before.enablers);

    var oldLinks = {}, newLinks = {};
    before.enablers.forEach(function (e) { e.links.forEach(function (l) { oldLinks[e.id + '>' + l] = { enabler: e.id, opp: l }; }); });
    after.enablers.forEach(function (e) { e.links.forEach(function (l) { newLinks[e.id + '>' + l] = { enabler: e.id, opp: l }; }); });
    Object.keys(newLinks).forEach(function (k) { if (!oldLinks[k]) ops.push({ table: 'enabler_links', op: 'link', enabler: newLinks[k].enabler, opp: newLinks[k].opp }); });
    Object.keys(oldLinks).forEach(function (k) {
      var l = oldLinks[k];
      if (!newLinks[k] && !goneEn.some(function (e) { return e.id === l.enabler; }) && !goneOpps.some(function (o) { return o.id === l.opp; })) ops.push({ table: 'enabler_links', op: 'unlink', enabler: l.enabler, opp: l.opp });
    });
    var goneLearning = rows('learning_items', after.learning, learningRow, before.learning);
    var goneTriage = rows('triage_items', after.triage, triageRow, before.triage);

    /* An Opportunity that was merged or folded away keeps its votes: they go
       to the Opportunity it now lives in. */
    goneOpps.forEach(function (o) {
      var to = R.resolve(after, o.id), hit = R.findAny(after, to);
      var target = hit && (hit.kind === 'opportunity' ? hit.row.id : hit.kind === 'item' ? hit.row.parentId : null);
      if (target && (o.votes || 0) > 0) ops.push({ table: 'votes', op: 'moveVotes', fromUid: o.uid, to: target });
    });
    goneItems.forEach(function (x) { ops.push({ table: 'register_items', op: 'delete', uid: x.uid, id: x.id }); });
    goneEn.forEach(function (x) { ops.push({ table: 'enablers', op: 'delete', uid: x.uid, id: x.id }); });
    goneLearning.forEach(function (x) { ops.push({ table: 'learning_items', op: 'delete', uid: x.uid, id: x.id }); });
    goneTriage.forEach(function (x) { ops.push({ table: 'triage_items', op: 'delete', uid: x.uid, id: x.id }); });
    goneOpps.forEach(function (x) { ops.push({ table: 'opportunities', op: 'delete', uid: x.uid, id: x.id }); });

    Object.keys(after.aliases).forEach(function (k) {
      if (before.aliases[k] !== after.aliases[k]) ops.push({ table: 'register_aliases', op: 'upsert', row: { old_ref: k, new_ref: after.aliases[k] } });
    });
    after.log.slice(before.log.length).forEach(function (l) { ops.push({ table: 'register_log', op: 'insert', row: { action: l.action, detail: l.detail || {} } }); });

    /* Order: inserts and updates of parents first, then children, then the
       rest; deletes already come after all of them. */
    var rank = { opportunities: 0, register_items: 1, enablers: 2, enabler_links: 3, learning_items: 4, triage_items: 5, votes: 6, register_aliases: 8, register_log: 9 };
    var phase = function (o) { return o.op === 'delete' ? 7 : rank[o.table]; };
    return ops.map(function (o, i) { return { o: o, i: i }; }).sort(function (a, b) { return (phase(a.o) - phase(b.o)) || (a.i - b.i); }).map(function (x) { return x.o; });
  }

  return { fromRows: fromRows, diff: diff, oppRow: oppRow, itemRow: itemRow };
});
