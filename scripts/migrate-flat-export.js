/* One-off migration: old flat exports into the hierarchical register,
   through the same consolidation pipeline the app uses, with a review step.

   1. Plan. Reads the exports, drops an export wholly contained in a later
      one, imports every row, asks Claude to consolidate, and writes the
      proposed changes for review. Nothing is applied.
        node scripts/migrate-flat-export.js plan <fixture.json | exports folder> --out <folder>
        (add --proposal <file> to reuse a saved model reply instead of calling Claude)
   2. Review. Open <folder>/review.md. Set each change in decisions.json to
      true (apply) or false (reject).
   3. Apply. Refuses while any decision is still null, unless --approve-all.
        node scripts/migrate-flat-export.js apply --out <folder> [--approve-all]
      Writes after.json and report.md (counts by type before and after, and
      the Opportunity list). Loading after.json into a workshop is a
      separate, later step.

   Needs ANTHROPIC_API_KEY for plan, unless --proposal is given. */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./common.js');
const R = require('../lib/register.js');
const P = require('../lib/pipeline.js');

const CONTEXT = 'CLIENT: a retail business, finance and purchasing teams, three-day AI opportunity engagement.\n' +
  'FUNCTIONS (pick one for "function"): Finance | Purchasing | Both | Org-wide.';

async function plan(input, outDir, opts) {
  const exports = C.readInput(input);
  const combined = P.combineExports(exports);
  exports.forEach(e => e.rows.forEach(r => { r._from = r._from || (e.name + ' ' + (r.ID || '')); }));
  const before = P.flatRowsToRegister(combined.rows);
  const ask = opts.proposal ? () => C.readJSON(opts.proposal)
    : (prompt) => C.askJSON(prompt, P.consolidateSchema(['Finance', 'Purchasing', 'Both', 'Org-wide']), { effort: 'high', maxTokens: 64000 });
  const t0 = Date.now();
  const res = await P.consolidate(before, C.template('consolidate'), ask, { context: CONTEXT });
  const decisions = {}; res.changes.forEach(c => { decisions[c.id] = null; });
  C.writeJSON(path.join(outDir, 'before.json'), before);
  C.writeJSON(path.join(outDir, 'proposal.json'), res.proposal);
  C.writeJSON(path.join(outDir, 'changes.json'), res.changes);
  if (!fs.existsSync(path.join(outDir, 'decisions.json')) || opts.fresh) C.writeJSON(path.join(outDir, 'decisions.json'), decisions);
  const lines = ['# Migration review', '', 'Exports read: ' + exports.map(e => e.name + ' (' + e.rows.length + ' rows)').join(', '),
    'Contained in a later export, so skipped: ' + (combined.subsets.join(', ') || 'none'),
    'A different client, so set aside: ' + (combined.otherClient.map(e => e.name + ' (' + e.client + ', ' + e.rows + ' rows)').join(', ') || 'none'),
    'Rows after skipping: ' + combined.raw + '. Identical titles kept once: ' + combined.exactRepeats + '. Rows imported: ' + before.opportunities.length + '.',
    'Rows the model did not place: ' + (res.unplaced.join(', ') || 'none'), '',
    '| Change | Kind | Before | After | Reason |', '|---|---|---|---|---|'];
  res.changes.forEach(c => { const d = R.describe(before, c); lines.push('| ' + [c.id, c.kind, d.before, d.after, c.reason || ''].map(x => String(x).replace(/\|/g, '/')).join(' | ') + ' |'); });
  fs.writeFileSync(path.join(outDir, 'review.md'), lines.join('\n') + '\n');
  return { exports, combined, before, res, seconds: Math.round((Date.now() - t0) / 1000) };
}

function apply(outDir, opts) {
  const before = C.readJSON(path.join(outDir, 'before.json'));
  const changes = C.readJSON(path.join(outDir, 'changes.json'));
  const decisions = C.readJSON(path.join(outDir, 'decisions.json'));
  const open = changes.filter(c => decisions[c.id] !== true && decisions[c.id] !== false);
  if (open.length && !opts.approveAll) { console.error(open.length + ' changes have no decision yet. Set each to true or false in decisions.json, or pass --approve-all.'); process.exit(3); }
  if (opts.approveAll) open.forEach(c => { decisions[c.id] = true; });
  const out = R.applyChanges(before, changes, decisions, { by: 'migration', createdBy: 'migration' });
  C.writeJSON(path.join(outDir, 'after.json'), out.register);
  C.writeJSON(path.join(outDir, 'results.json'), out.results);
  fs.writeFileSync(path.join(outDir, 'report.md'), report(before, out) + '\n');
  return out;
}

function counts(reg) {
  const s = R.summary(reg);
  return [['Opportunities', s.opportunities], ['Build steps', s.build_step], ['Guardrails', s.guardrail], ['Dependencies', s.dependency],
    ['Setup actions', s.setup_action], ['Open questions', s.open_question], ['Enablers', s.enablers], ['Learning items', s.learning], ['Triage', s.triage]];
}
function report(before, out) {
  const g = out.register, b = counts(before), a = counts(g);
  const auto = g.items.filter(i => i.auto).length;
  const lines = ['# Migration result', '', '| Type | Before | After |', '|---|---|---|'];
  b.forEach((row, i) => lines.push('| ' + row[0] + ' | ' + row[1] + ' | ' + a[i][1] + ' |'));
  lines.push('', 'Open questions after include ' + auto + ' raised automatically for a missing owner, trigger or time per round.');
  const tally = {}; out.results.forEach(r => { tally[r.status] = (tally[r.status] || 0) + 1; });
  lines.push('Changes: ' + Object.entries(tally).map(([k, v]) => v + ' ' + k).join(', ') + '.');
  out.results.filter(r => r.status === 'failed' || r.status === 'skipped').forEach(r => lines.push('- ' + r.id + ' ' + r.status + ': ' + r.reason));
  lines.push('', '## Opportunities', '', '| ID | Opportunity | Owner | Frequency | Time | Children | Blocked | Needs qualification |', '|---|---|---|---|---|---|---|---|');
  g.opportunities.forEach(o => {
    const kids = R.childrenOf(g, o.id).filter(i => !i.auto), n = kids.length, c = {};
    kids.forEach(i => { c[i.type] = (c[i.type] || 0) + 1; });
    const autoQ = R.childrenOf(g, o.id).filter(i => i.auto && i.status === 'Open').length;
    lines.push('| ' + [o.id, o.title, o.owner || '?', o.frequency || '?', o.timeBand || '?',
      n + (n ? ' (' + R.CHILD_TYPES.filter(t => c[t]).map(t => c[t] + ' ' + R.TYPE_LABELS[t].toLowerCase()).join(', ') + ')' : '') + (autoQ ? ', plus ' + autoQ + ' qualification question' + (autoQ > 1 ? 's' : '') : ''),
      R.isBlocked(g, o.id) ? 'Yes' : '', R.needsQualification(o) ? 'Yes' : ''].join(' | ') + ' |');
  });
  lines.push('', '## Enablers', '');
  g.enablers.forEach(e => lines.push('- ' + e.id + ' ' + e.text + ' (' + e.owner + '), blocks ' + e.links.join(', ')));
  lines.push('', '## Learning backlog', '');
  g.learning.forEach(l => lines.push('- ' + l.id + ' ' + l.text + (l.module ? ' [' + l.module + ']' : '')));
  if (g.triage.length) { lines.push('', '## Triage', ''); g.triage.forEach(t => lines.push('- ' + t.id + ' ' + t.text + ' (' + t.reason + ')')); }
  return lines.join('\n');
}

async function main() {
  const cmd = process.argv[2], outDir = C.arg('out');
  if (!outDir || !['plan', 'apply'].includes(cmd)) { console.error('Usage: plan <input> --out <folder> | apply --out <folder> [--approve-all]'); process.exit(1); }
  if (cmd === 'plan') {
    const input = process.argv[3];
    const r = await plan(input, outDir, { proposal: C.arg('proposal'), fresh: C.flag('fresh') });
    console.log('Planned ' + r.res.changes.length + ' changes from ' + r.before.opportunities.length + ' rows in ' + r.seconds + 's. Review ' + path.join(outDir, 'review.md'));
    if (r.res.unplaced.length) console.log('Not placed by the model: ' + r.res.unplaced.join(', '));
  } else {
    apply(outDir, { approveAll: C.flag('approve-all') });
    console.log(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'));
  }
}
if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });
module.exports = { plan, apply, report, counts };
