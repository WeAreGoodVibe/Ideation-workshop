/* Shared helpers for the Vercel functions. No dependencies: Node 18+ fetch. */
'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

/* Who is calling, from the Supabase JWT the browser sends. */
async function userFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !SUPABASE_URL) return null;
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: ANON, authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  return r.json();
}

/* Service-role query against PostgREST. */
async function sb(path, init) {
  const opts = Object.assign({}, init || {});
  opts.headers = Object.assign({ apikey: SERVICE, authorization: 'Bearer ' + SERVICE, 'content-type': 'application/json', prefer: 'return=representation' }, (init && init.headers) || {});
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!r.ok) throw new Error('supabase ' + r.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)));
  return data;
}
async function sbGet(path) { return sb(path, { method: 'GET' }); }
async function sbPost(path, body) { return sb(path, { method: 'POST', body: JSON.stringify(body) }); }
async function sbPatch(path, body) { return sb(path, { method: 'PATCH', body: JSON.stringify(body) }); }

async function isFacilitator(userId, workshopId) {
  const ws = await sbGet('workshops?id=eq.' + workshopId + '&select=org_id');
  if (!ws || !ws[0]) return false;
  const m = await sbGet('org_members?org_id=eq.' + ws[0].org_id + '&user_id=eq.' + userId + '&role=eq.facilitator&select=user_id');
  return !!(m && m[0]);
}

/* Claude, from the server. The key never reaches a browser. */
async function askClaude(prompt, opts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set on the server');
  const body = {
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    max_tokens: 6000,
    output_config: { effort: (opts && opts.effort) || 'low' },
    messages: [{ role: 'user', content: prompt }]
  };
  if (opts && opts.schema) body.output_config.format = { type: 'json_schema', schema: opts.schema };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error('anthropic ' + r.status + ': ' + ((j.error && j.error.message) || ''));
  if (j.stop_reason === 'refusal') throw new Error('The model declined this window.');
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseLooseJSON(text);
}
function parseLooseJSON(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  throw new Error('No JSON in the model reply');
}

module.exports = { json, readBody, userFromRequest, sbGet, sbPost, sbPatch, isFacilitator, askClaude, SUPABASE_URL, ANON };
