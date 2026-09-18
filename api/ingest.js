/* POST /api/ingest
   Header:  x-bridge-token: <the workshop's bridge token>
   Body:    { workshopId, transcript: [{ text, src? }], opportunities: [{...}] }

   The door for a Claude Code or Cowork session that polls Wispr Flow and
   pushes what it hears. The token is per workshop and is shown to the
   facilitator in Settings. Nothing else is accepted on this route. */
'use strict';
const { json, readBody, sbGet, sbPost } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const token = req.headers['x-bridge-token'] || '';
    const body = await readBody(req);
    if (!body.workshopId || !token) return json(res, 400, { error: 'workshopId and x-bridge-token are required' });
    const secret = await sbGet('workshop_secrets?workshop_id=eq.' + body.workshopId + '&select=bridge_token');
    if (!secret || !secret[0] || secret[0].bridge_token !== token) return json(res, 403, { error: 'Bad token' });

    let chunks = 0, ideas = 0;
    const t = Array.isArray(body.transcript) ? body.transcript : [];
    if (t.length) {
      await sbPost('transcript_chunks', t.filter(c => c && (c.text || typeof c === 'string')).map(c => ({
        workshop_id: body.workshopId, text: String(c.text || c), src: c.src || 'bridge'
      })));
      chunks = t.length;
    }
    const ops = Array.isArray(body.opportunities) ? body.opportunities : [];
    if (ops.length) {
      const existing = await sbGet('opportunities?workshop_id=eq.' + body.workshopId + '&select=title');
      const seen = new Set((existing || []).map(o => norm(o.title)));
      const rows = ops.filter(o => o && o.title && !seen.has(norm(o.title))).map(o => ({
        workshop_id: body.workshopId, title: o.title, fn: o.function || o.fn || 'Both', phase: o.phase || '',
        surface: o.surface || 'Claude Chat', build: o.build || 'Skill', pain: o.pain || '', direction: o.direction || '',
        systems: Array.isArray(o.systems) ? o.systems : [], quote: o.quote || '', raised_by: o.raisedBy || 'Room',
        source: 'AI', confidence: o.confidence || 'Medium', status: 'Open'
      }));
      if (rows.length) { await sbPost('opportunities', rows); ideas = rows.length; }
    }
    return json(res, 200, { ok: true, transcript: chunks, opportunities: ideas });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
};
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
