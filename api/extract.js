/* POST /api/extract  { workshopId, prompt, mode: "extract" | "second" | "prompts", stream }
   Facilitators only. Runs the prompt the page built through Claude with the
   server-side key and returns the parsed JSON, or with stream set, the reply
   as it is written. The page inserts the rows
   itself under its own row-level-security rights. */
'use strict';
const { json, readBody, tokenFromRequest, userFromRequest, isFacilitator, askClaude, streamClaude } = require('./_lib');

/* The team tags come from the workshop (the page sends them); this list is
   only the fallback for an old page that does not. */
const FUNCTIONS = ['Finance', 'Purchasing', 'Both', 'Org-wide'];
const SURFACES = ['Claude Chat', 'Claude Project', 'Scheduled Task', 'Cowork', 'Skill', 'Connector setup'];
const BUILDS = ['Skill', 'Scheduled task', 'Setup', 'Project', 'Workflow redesign'];

function functionsFrom(body) {
  const list = Array.isArray(body.functions) ? body.functions.filter(f => typeof f === 'string' && f.trim() && f.length <= 40).slice(0, 12) : [];
  return list.length ? list : FUNCTIONS;
}
/* One read returns three things heard in the window: opportunities, systems
   the room named, and process phases it described. The page adds what is
   new, so a blank workshop fills itself as the room talks. */
const extractSchema = (functions) => ({
  type: 'object', additionalProperties: false, required: ['opportunities', 'systems', 'phases'],
  properties: {
    opportunities: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['title', 'function', 'phase', 'surface', 'build', 'pain', 'direction', 'systems', 'quote', 'raisedBy', 'confidence'],
      properties: {
        title: { type: 'string' }, function: { type: 'string', enum: functions }, phase: { type: 'string' },
        surface: { type: 'string', enum: SURFACES }, build: { type: 'string', enum: BUILDS },
        pain: { type: 'string' }, direction: { type: 'string' }, systems: { type: 'array', items: { type: 'string' } },
        quote: { type: 'string' }, raisedBy: { type: 'string' }, confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] }
      } } },
    systems: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'category', 'usedBy', 'note'],
      properties: { name: { type: 'string' }, category: { type: 'string' }, usedBy: { type: 'string' }, note: { type: 'string' } } } },
    phases: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'function', 'what'],
      properties: { name: { type: 'string' }, function: { type: 'string', enum: functions }, what: { type: 'string' } } } }
  }
});

/* mode "prompts": for each opportunity the room landed on, write the thing
   that builds it. Three artefacts, because they are used at three different
   moments: an interview to pull the detail out of the person who owns the
   work, the artefact itself (a skill, a scheduled task, project instructions),
   and the first message to paste once it exists. */
const PACK_KINDS = ['Skill', 'Scheduled task', 'Project', 'Setup', 'Workflow redesign'];
const promptsSchema = {
  type: 'object', additionalProperties: false, required: ['packs'],
  properties: { packs: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['id', 'title', 'kind', 'artefactName', 'interview', 'artefact', 'firstRun', 'connectors', 'watchOut'],
    properties: {
      id: { type: 'string' }, title: { type: 'string' },
      kind: { type: 'string', enum: PACK_KINDS }, artefactName: { type: 'string' },
      interview: { type: 'string' }, artefact: { type: 'string' }, firstRun: { type: 'string' },
      connectors: { type: 'array', items: { type: 'string' } }, watchOut: { type: 'string' }
    } } } }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const user = await userFromRequest(req);
    if (!user) return json(res, 401, { error: 'Sign in first' });
    const body = await readBody(req);
    if (!body.workshopId || !body.prompt) return json(res, 400, { error: 'workshopId and prompt are required' });
    if (!(await isFacilitator(tokenFromRequest(req), body.workshopId))) return json(res, 403, { error: 'Facilitators only' });
    if (String(body.prompt).length > 200000) return json(res, 413, { error: 'Prompt too long' });
    /* The ceilings are generous because the model thinks before it writes and
       that thinking counts against them: at high effort over a long transcript
       it can use most of the old 6000 on its own, which cut the reply off. */
    let opts;
    if (body.mode === 'second') opts = { effort: 'high', maxTokens: 32000 };
    else if (body.mode === 'prompts') opts = { effort: 'low', maxTokens: 32000, schema: promptsSchema };
    else opts = { effort: 'low', maxTokens: 16000, schema: extractSchema(functionsFrom(body)) };
    if (!body.stream) return json(res, 200, await askClaude(body.prompt, opts));
    /* Streamed: one JSON object per line. {"t":…} is the next piece of the
       reply, then {"done":true,"stop":…} or {"error":…}. The page builds the
       JSON itself and puts each idea on the board as soon as it is whole. */
    const open = () => {
      if (res.headersSent) return;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-accel-buffering', 'no');
    };
    const out = await streamClaude(body.prompt, opts, t => { open(); res.write(JSON.stringify({ t }) + '\n'); });
    open();
    try {
      const stop = await out.done;
      /* One line per call so a failure can be read from the Vercel logs, not
         only from the facilitator's screen. */
      console.log(JSON.stringify({ mode: body.mode || 'extract', stop, promptChars: String(body.prompt).length }));
      res.end(JSON.stringify(stop === 'refusal' ? { error: 'The model declined this window.' } : { done: true, stop }) + '\n');
    } catch (e) {
      console.error('extract stream failed', body.mode || 'extract', String(e.message || e));
      res.end(JSON.stringify({ error: String(e.message || e) }) + '\n');
    }
  } catch (e) {
    console.error('extract failed', String(e.message || e));
    if (res.headersSent) return res.end(JSON.stringify({ error: String(e.message || e) }) + '\n');
    return json(res, 500, { error: String(e.message || e) });
  }
};
