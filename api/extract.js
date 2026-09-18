/* POST /api/extract  { workshopId, prompt, mode: "extract" | "second" }
   Facilitators only. Runs the prompt the page built through Claude with the
   server-side key and returns the parsed JSON. The page inserts the rows
   itself under its own row-level-security rights. */
'use strict';
const { json, readBody, tokenFromRequest, userFromRequest, isFacilitator, askClaude } = require('./_lib');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  try {
    const user = await userFromRequest(req);
    if (!user) return json(res, 401, { error: 'Sign in first' });
    const body = await readBody(req);
    if (!body.workshopId || !body.prompt) return json(res, 400, { error: 'workshopId and prompt are required' });
    if (!(await isFacilitator(tokenFromRequest(req), body.workshopId))) return json(res, 403, { error: 'Facilitators only' });
    if (String(body.prompt).length > 200000) return json(res, 413, { error: 'Prompt too long' });
    const result = body.mode === 'second'
      ? await askClaude(body.prompt, { effort: 'high' })
      : await askClaude(body.prompt, { effort: 'low', schema: extractSchema(functionsFrom(body)) });
    return json(res, 200, result);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
};
