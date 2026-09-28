/* Run the migration on the anonymised fixture and check it against
   test/fixtures/acceptance.json. The model is not deterministic, so this runs
   several times (default 3) and reports each run; it is an eval, not a unit
   test, and needs ANTHROPIC_API_KEY.

   node scripts/eval-fixture.js [--runs 3] [--out <scratch folder>] */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./common.js');
const R = require('../lib/register.js');
const M = require('./migrate-flat-export.js');

function check(acc, exports, after, before) {
  const out = [];
  const pass = (ok, what) => out.push((ok ? 'PASS ' : 'FAIL ') + what);
  const sub = exports.find(e => e.name === acc.subsetExport);
  const combined = require('../lib/pipeline.js').combineExports(exports);
  if (sub) pass(combined.subsets.includes(sub.name), acc.subsetExport + ' detected as a subset of a later export');
  const raw = exports.filter(e => acc.rawRowsAcross.includes(e.name)).reduce((n, e) => n + e.rows.length, 0);
  pass(raw === acc.rawRows, acc.rawRows + ' raw rows across ' + acc.rawRowsAcross.join(' and ') + ' (found ' + raw + ')');
  const n = after.opportunities.filter(o => o.status !== 'Parked').length;
  pass(n >= acc.opportunities.min && n <= acc.opportunities.max, 'Opportunities between ' + acc.opportunities.min + ' and ' + acc.opportunities.max + ' (got ' + n + ')');
  const dupes = [];
  after.opportunities.forEach((a, i) => after.opportunities.slice(i + 1).forEach(b => { if (R.similarity(a.title, b.title) >= R.THRESHOLDS.merge) dupes.push(a.id + '~' + b.id); }));
  after.items.filter(x => !x.auto).forEach((a, i, all) => all.slice(i + 1).forEach(b => { if (a.parentId === b.parentId && a.type === b.type && R.similarity(a.text, b.text) >= R.THRESHOLDS.merge) dupes.push(a.id + '~' + b.id); }));
  pass(!dupes.length, 'No duplicate rows' + (dupes.length ? ' (' + dupes.join(', ') + ')' : ''));
  acc.checks.forEach(ch => {
    const re = new RegExp(ch.row, 'i');
    const src = before.opportunities.filter(o => re.test(o.title));
    if (!src.length) { pass(false, '"' + ch.row + '" matches no fixture row'); return; }
    src.forEach(o => {
      const hit = R.findAny(after, o.id);
      let ok = false, got = hit ? hit.kind + (hit.kind === 'item' ? ' ' + hit.row.type + ' under ' + hit.row.parentId : '') : 'missing';
      if (ch.becomes === 'learning') ok = hit && hit.kind === 'learning';
      else if (ch.becomes === 'enabler') { ok = hit && hit.kind === 'enabler' && hit.row.links.length >= (ch.minLinks || 1); if (hit && hit.kind === 'enabler') got += ' linked to ' + hit.row.links.length; }
      else { ok = hit && hit.kind === 'item' && hit.row.type === ch.becomes && (!ch.parentTitle || new RegExp(ch.parentTitle, 'i').test(R.findOpp(after, hit.row.parentId).title)); if (ok || (hit && hit.kind === 'item')) got += ' (' + R.findOpp(after, hit.row.parentId).title + ')'; }
      pass(ok, o.id + ' "' + o.title + '" becomes ' + ch.becomes + ' (got ' + got + ')');
    });
  });
  return out;
}

async function main() {
  const acc = C.readJSON(path.join(C.REPO, 'test', 'fixtures', 'acceptance.json'));
  const fixture = path.join(C.REPO, acc.fixture);
  if (!fs.existsSync(fixture)) { console.error('No fixture at ' + fixture + '. Build it with scripts/anonymise-fixture.js first.'); process.exit(1); }
  const runs = parseInt(C.arg('runs', '3'), 10), base = C.arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'register-eval-')));
  const exports = C.readInput(fixture);
  let passed = 0;
  for (let i = 1; i <= runs; i++) {
    const dir = path.join(base, 'run' + i);
    const p = await M.plan(fixture, dir, { fresh: true, proposal: C.arg('proposal') });
    const out = M.apply(dir, { approveAll: true });
    const lines = check(acc, exports, out.register, p.before);
    const ok = lines.every(l => l.startsWith('PASS'));
    if (ok) passed++;
    console.log('\nRun ' + i + ' (' + p.seconds + 's, ' + p.res.changes.length + ' changes' + (p.res.unplaced.length ? ', ' + p.res.unplaced.length + ' rows unplaced' : '') + '): ' + (ok ? 'PASS' : 'FAIL') + '  ' + dir);
    lines.forEach(l => console.log('  ' + l));
    console.log('  Counts after: ' + M.counts(out.register).map(([k, v]) => k + ' ' + v).join(', '));
  }
  console.log('\n' + passed + ' of ' + runs + ' runs passed.');
  process.exit(passed === runs ? 0 : 1);
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
