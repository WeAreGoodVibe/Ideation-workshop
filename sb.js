/* ============================================================================
   sb.js: the Supabase layer.

   The page works without it (local mode, one browser). When /api/config
   returns a Supabase URL, this file signs people in with a magic link, loads
   the workshop they were invited to, keeps the board in sync over realtime,
   and routes every write through row level security.

   app.js talks to it through a small surface:
     SB.init()                 -> true when a backend is configured
     SB.on('auth' | 'data' | 'toast', fn)
     SB.openWorkshop(slug)     -> { ok } | { error: 'join' | message }
     SB.user, SB.role, SB.ws, SB.active
     writes: insertOpportunity, updateOpportunity, deleteOpportunity, vote,
             insertSystem, updateSystem, deleteSystem, updateWorkshop,
             addTranscript, setAIIdeas, api(mode, prompt)
     admin:  listOrgs, createOrg, listWorkshops, createWorkshop, members,
             bridgeToken, sendLink, joinAnonymously, isAnon, signOut
   ========================================================================== */
window.SB = (function () {
  'use strict';

  var client = null, cfg = null, session = null, user = null, ws = null, role = null, org = null;
  var active = false, channel = null, hooks = {}, refreshT = {}, myDots = {}, tallies = {}, quiet = false;

  function on(name, fn) { hooks[name] = fn; }
  function emit(name, a) { if (hooks[name]) try { hooks[name](a); } catch (e) { console.error(e); } }
  function param(k) { try { return new URLSearchParams(location.search).get(k) || ''; } catch (e) { return ''; } }
  function ls(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }

  async function init() {
    try { var r = await fetch('/api/config', { cache: 'no-store' }); cfg = await r.json(); } catch (e) { cfg = null; }
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) return false;
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true } });
    var s = await client.auth.getSession(); session = s.data.session; user = session ? session.user : null;
    client.auth.onAuthStateChange(function (ev, sess) {
      var had = !!user; session = sess; user = sess ? sess.user : null;
      if (quiet) return;
      if ((ev === 'SIGNED_IN' && !had) || ev === 'SIGNED_OUT') emit('auth', ev);
    });
    return true;
  }

  /* ---------------------------------------------------------- auth ------ */
  async function sendLink(email, name, slug, code) {
    ls('wos.join', { name: name || '', slug: slug || '', code: code || '' });
    var redirect = location.origin + location.pathname + (slug ? '?w=' + encodeURIComponent(slug) : '');
    var r = await client.auth.signInWithOtp({ email: email, options: { emailRedirectTo: redirect, data: { display_name: name || '' } } });
    if (r.error) throw r.error;
    return true;
  }
  /* Participants scan the QR on the screen and join with a name only: an
     anonymous Supabase session, no email round trip. The join code in the QR
     is the same one shown on the screen, so this opens nothing the room could
     not already reach. Needs "Allow anonymous sign-ins" on in Supabase Auth. */
  async function joinAnonymously(slug, code, name) {
    ls('wos.join', { name: name || '', slug: slug, code: code });
    if (!user) {
      quiet = true;
      try {
        var r = await client.auth.signInAnonymously({ options: { data: { display_name: name || '' } } });
        if (r.error) throw r.error;
        session = r.data.session; user = r.data.user;
      } finally { quiet = false; }
    }
    return joinWithCode(slug, code, name);
  }
  function isAnon() { return !!(user && user.is_anonymous); }
  async function signOut() { await client.auth.signOut(); unsubscribe(); active = false; ws = null; role = null; location.href = location.pathname; }

  /* ------------------------------------------------------ workshop ------ */
  async function openWorkshop(slug) {
    var q = await client.from('workshops').select('*').eq('slug', slug).maybeSingle();
    if (!q.data) {
      var j = ls('wos.join') || {}; var code = param('code') || j.code || '';
      if (!code) return { error: 'join' };
      var jr = await client.rpc('join_workshop', { p_slug: slug, p_code: code, p_name: j.name || null });
      if (jr.error) return { error: jr.error.message };
      q = await client.from('workshops').select('*').eq('slug', slug).maybeSingle();
      if (!q.data) return { error: 'join' };
    }
    ws = q.data;
    var rr = await client.rpc('my_role', { p_ws: ws.id }); role = rr.data || 'participant';
    var o = await client.from('orgs').select('*').eq('id', ws.org_id).maybeSingle(); org = o.data;
    active = true;
    await refreshAll();
    subscribe();
    return { ok: true };
  }
  async function joinWithCode(slug, code, name) {
    ls('wos.join', { name: name || '', slug: slug, code: code });
    var jr = await client.rpc('join_workshop', { p_slug: slug, p_code: code, p_name: name || null });
    if (jr.error) throw jr.error;
    return openWorkshop(slug);
  }

  async function refreshAll() {
    var id = ws.id, fac = role === 'facilitator';
    var reqs = [
      client.from('workshops').select('*').eq('id', id).maybeSingle(),
      client.from('systems').select('*').eq('workshop_id', id).order('sort'),
      client.from('opportunities').select('*').eq('workshop_id', id).order('seq'),
      client.from('vote_tallies').select('*').eq('workshop_id', id),
      client.from('votes').select('opportunity_id,dots').eq('workshop_id', id).eq('user_id', user.id),
      client.from('second_ideas').select('*').eq('workshop_id', id).order('sort'),
      fac ? client.from('transcript_chunks').select('*').eq('workshop_id', id).order('id') : Promise.resolve({ data: [] })
    ];
    var r = await Promise.all(reqs);
    ws = r[0].data || ws;
    tallies = {}; (r[3].data || []).forEach(function (t) { tallies[t.opportunity_id] = t; });
    myDots = {}; (r[4].data || []).forEach(function (v) { myDots[v.opportunity_id] = v.dots; });
    emit('data', { workshop: ws, systems: r[1].data || [], opportunities: (r[2].data || []).map(mapOp), second: r[5].data || [], transcript: r[6].data || [], full: true });
  }
  function mapOp(row) {
    var t = tallies[row.id] || {};
    return { id: 'O' + row.seq, uid: row.id, seq: row.seq, title: row.title, fn: row.fn, phase: row.phase || '', cluster: row.cluster || '',
      surface: row.surface || '', build: row.build || '', pain: row.pain || '', direction: row.direction || '', systems: row.systems || [],
      quote: row.quote || '', raisedBy: row.raised_by || '', owner: row.owner || '', status: row.status, source: row.source, confidence: row.confidence || 'Medium',
      notes: row.notes || '', value: row.value, ease: row.ease, votes: t.total || 0, voters: t.names || [], myDots: myDots[row.id] || 0,
      createdAt: Date.parse(row.created_at) || 0, createdBy: row.created_by };
  }
  var refreshers = {
    workshops: async function () { var r = await client.from('workshops').select('*').eq('id', ws.id).maybeSingle(); if (r.data) { ws = r.data; emit('data', { workshop: ws }); } },
    systems: async function () { var r = await client.from('systems').select('*').eq('workshop_id', ws.id).order('sort'); emit('data', { systems: r.data || [] }); },
    opportunities: async function () {
      var r = await Promise.all([client.from('opportunities').select('*').eq('workshop_id', ws.id).order('seq'), client.from('vote_tallies').select('*').eq('workshop_id', ws.id), client.from('votes').select('opportunity_id,dots').eq('workshop_id', ws.id).eq('user_id', user.id)]);
      tallies = {}; (r[1].data || []).forEach(function (t) { tallies[t.opportunity_id] = t; });
      myDots = {}; (r[2].data || []).forEach(function (v) { myDots[v.opportunity_id] = v.dots; });
      emit('data', { opportunities: (r[0].data || []).map(mapOp) });
    },
    second_ideas: async function () { var r = await client.from('second_ideas').select('*').eq('workshop_id', ws.id).order('sort'); emit('data', { second: r.data || [] }); }
  };
  refreshers.votes = refreshers.opportunities;
  function refresh(table) { clearTimeout(refreshT[table]); refreshT[table] = setTimeout(function () { refreshers[table] && refreshers[table]().catch(function (e) { console.warn('refresh', table, e); }); }, 250); }

  function subscribe() {
    unsubscribe();
    channel = client.channel('ws-' + ws.id);
    ['workshops', 'systems', 'opportunities', 'votes', 'second_ideas'].forEach(function (t) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: (t === 'workshops' ? 'id' : 'workshop_id') + '=eq.' + ws.id }, function () { refresh(t); });
    });
    channel.subscribe(function (status) { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { setTimeout(function () { if (active) subscribe(); }, 4000); } });
    /* Realtime can miss a beat; a slow poll keeps every screen honest. */
    clearInterval(refreshT.poll); refreshT.poll = setInterval(function () { if (active && !document.hidden) refreshAll().catch(function () {}); }, 45000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && active) refreshAll().catch(function () {}); });
  }
  function unsubscribe() { if (channel) { try { client.removeChannel(channel); } catch (e) {} channel = null; } clearInterval(refreshT.poll); }

  /* -------------------------------------------------------- writes ------ */
  function rowFromOp(o) {
    var r = {};
    [['title', 'title'], ['fn', 'fn'], ['phase', 'phase'], ['cluster', 'cluster'], ['surface', 'surface'], ['build', 'build'], ['pain', 'pain'], ['direction', 'direction'], ['systems', 'systems'], ['quote', 'quote'], ['raisedBy', 'raised_by'], ['owner', 'owner'], ['status', 'status'], ['source', 'source'], ['confidence', 'confidence'], ['notes', 'notes'], ['value', 'value'], ['ease', 'ease']]
      .forEach(function (p) { if (o[p[0]] !== undefined) r[p[1]] = o[p[0]]; });
    return r;
  }
  function fail(e, what) { var m = (e && (e.message || e.error_description)) || String(e); emit('toast', what + ': ' + m); throw e; }
  async function insertOpportunity(o) { var r = await client.from('opportunities').insert(Object.assign({ workshop_id: ws.id }, rowFromOp(o))).select().single(); if (r.error) fail(r.error, 'Could not add'); refresh('opportunities'); return r.data; }
  async function updateOpportunity(uid, patch) { var r = await client.from('opportunities').update(rowFromOp(patch)).eq('id', uid); if (r.error) fail(r.error, 'Could not save'); }
  async function deleteOpportunity(uid) { var r = await client.from('opportunities').delete().eq('id', uid); if (r.error) fail(r.error, 'Could not delete'); refresh('opportunities'); }
  async function vote(uid, delta) {
    var r = await client.rpc('cast_vote', { p_opp: uid, p_delta: delta });
    if (r.error) { emit('toast', /budget/.test(r.error.message) ? 'No dots left. Take one back from another idea first.' : 'Vote failed: ' + r.error.message); return null; }
    refresh('opportunities'); return r.data;
  }
  async function insertSystem(s) { var r = await client.from('systems').insert({ workshop_id: ws.id, name: s.name, category: s.category || '', used_by: s.usedBy || '', connector: s.connector || '', status: s.status || 'assumed', note: s.note || '', sort: s.sort || 99 }); if (r.error) fail(r.error, 'Could not add'); refresh('systems'); }
  async function updateSystem(uid, s) { var r = await client.from('systems').update({ name: s.name, category: s.category || '', used_by: s.usedBy || '', connector: s.connector || '', status: s.status || 'assumed', note: s.note || '' }).eq('id', uid); if (r.error) fail(r.error, 'Could not save'); }
  async function deleteSystem(uid) { var r = await client.from('systems').delete().eq('id', uid); if (r.error) fail(r.error, 'Could not delete'); refresh('systems'); }
  async function updateWorkshop(patch) { var r = await client.from('workshops').update(patch).eq('id', ws.id); if (r.error) fail(r.error, 'Could not save'); }
  async function addTranscript(text, src) { var r = await client.from('transcript_chunks').insert({ workshop_id: ws.id, text: text, src: src || 'manual' }); if (r.error) fail(r.error, 'Transcript not saved'); }
  async function setAIIdeas(list) {
    await client.from('second_ideas').delete().eq('workshop_id', ws.id).eq('origin', 'ai');
    if (list.length) { var r = await client.from('second_ideas').insert(list.map(function (i, n) { return { workshop_id: ws.id, key: 'A' + (n + 1), title: i.title, fn: i.fn || i.function || 'Both', phase: i.phase || '', surface: i.surface || '', build: i.build || '', what: i.what || '', why: i.why || '', lift: i.lift || '', comparator: i.comparator || '', confidence: i.confidence || 'Medium', origin: 'ai', sort: n + 1 }; })); if (r.error) fail(r.error, 'Ideas not saved'); }
    refresh('second_ideas');
  }
  async function api(mode, prompt) {
    var r = await fetch('/api/extract', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ workshopId: ws.id, prompt: prompt, mode: mode }) });
    var j = await r.json();
    if (!r.ok) throw { code: 'http_' + r.status, message: j.error || r.statusText };
    return j;
  }

  /* --------------------------------------------------------- admin ------ */
  async function listOrgs() { var r = await client.from('orgs').select('*').order('created_at'); return r.data || []; }
  async function createOrg(name, slug) {
    /* Insert without RETURNING: the creator's membership is added by a trigger
       after the row exists, so a same-statement read would be refused. */
    var r = await client.from('orgs').insert({ name: name, slug: slug, created_by: user.id });
    if (r.error) fail(r.error, 'Could not create the organisation');
    var q = await client.from('orgs').select('*').eq('slug', slug).maybeSingle();
    if (q.error || !q.data) fail(q.error || new Error('created but not readable'), 'Could not read the organisation back');
    return q.data;
  }
  async function listWorkshops() { var r = await client.from('workshops').select('id,org_id,slug,title,join_code,status,created_at').order('created_at', { ascending: false }); return r.data || []; }
  async function createWorkshop(orgId, fields, config) {
    var r = await client.from('workshops').insert({ org_id: orgId, slug: fields.slug, title: fields.title, join_code: fields.joinCode, max_dots: fields.maxDots || 3, config: config, created_by: user.id, status: 'live' }).select().single();
    if (r.error) fail(r.error, 'Could not create the workshop'); return r.data;
  }
  async function members() { if (!org) return []; var r = await client.from('org_members').select('*').eq('org_id', org.id).order('created_at'); return r.data || []; }
  async function bridgeToken() { var r = await client.from('workshop_secrets').select('bridge_token').eq('workshop_id', ws.id).maybeSingle(); return r.data ? r.data.bridge_token : ''; }
  async function myVotesUsed() { var n = 0; Object.keys(myDots).forEach(function (k) { n += myDots[k]; }); return n; }

  return {
    init: init, on: on, param: param, ls: ls,
    get user() { return user; }, get role() { return role; }, get ws() { return ws; }, get org() { return org; }, get active() { return active; }, get cfg() { return cfg; }, get myDots() { return myDots; },
    sendLink: sendLink, signOut: signOut, openWorkshop: openWorkshop, joinWithCode: joinWithCode, joinAnonymously: joinAnonymously, isAnon: isAnon, refreshAll: refreshAll,
    insertOpportunity: insertOpportunity, updateOpportunity: updateOpportunity, deleteOpportunity: deleteOpportunity, vote: vote,
    insertSystem: insertSystem, updateSystem: updateSystem, deleteSystem: deleteSystem, updateWorkshop: updateWorkshop,
    addTranscript: addTranscript, setAIIdeas: setAIIdeas, api: api,
    listOrgs: listOrgs, createOrg: createOrg, listWorkshops: listWorkshops, createWorkshop: createWorkshop, members: members, bridgeToken: bridgeToken, myVotesUsed: myVotesUsed
  };
})();
