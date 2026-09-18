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
function tokenFromRequest(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}
async function userFromRequest(req) {
  const token = tokenFromRequest(req);
  if (!token || !SUPABASE_URL) return null;
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: ANON, authorization: 'Bearer ' + token } });
  if (!r.ok) return null;
  return r.json();
}

/* A call as the signed-in person, under their own row level security. The
   anon key plus their JWT is all it needs, so the service key stays out of
   the facilitator path entirely. */
async function rpcAs(token, fn, args) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: ANON, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(args || {})
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!r.ok) throw new Error('supabase ' + r.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)));
  return data;
}

/* Service-role query against PostgREST. */
async function sb(path, init) {
  if (!SERVICE) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set on the server');
  const opts = Object.assign({}, init || {});
  /* Legacy service_role keys are JWTs and go in both headers. The newer
     sb_secret_ keys are not JWTs and must only be sent as apikey. */
  const base = { apikey: SERVICE, 'content-type': 'application/json', prefer: 'return=representation' };
  if (!/^sb_secret_/.test(SERVICE)) base.authorization = 'Bearer ' + SERVICE;
  opts.headers = Object.assign(base, (init && init.headers) || {});
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!r.ok) throw new Error('supabase ' + r.status + ': ' + (typeof data === 'string' ? data : JSON.stringify(data)));
  return data;
}
async function sbGet(path) { return sb(path, { method: 'GET' }); }
async function sbPost(path, body) { return sb(path, { method: 'POST', body: JSON.stringify(body) }); }
async function sbPatch(path, body) { return sb(path, { method: 'PATCH', body: JSON.stringify(body) }); }

/* Facilitator check as the caller: my_role() is the same function the page
   uses, so this cannot disagree with what the sidebar shows. */
async function isFacilitator(token, workshopId) {
  const role = await rpcAs(token, 'my_role', { p_ws: workshopId });
  return role === 'facilitator';
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

module.exports = { json, readBody, tokenFromRequest, userFromRequest, rpcAs, sbGet, sbPost, sbPatch, isFacilitator, askClaude, SUPABASE_URL, ANON };
