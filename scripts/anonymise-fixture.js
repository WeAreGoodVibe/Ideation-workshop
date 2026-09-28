/* Build the anonymised regression fixture from real exports.

   node scripts/anonymise-fixture.js <exports folder> --map <names.json> [--out test/fixtures/sept-exports.anon.json]

   The exports folder and names.json both stay OUTSIDE the repository. The
   script refuses otherwise. names.json lists what to replace:
     { "replace": { "Client Pty Ltd": "Client Co", "Supplier Name": "Supplier 1" } }
   People are found automatically in the Raised by and Owner columns and
   become Person A, Person B ... The people map is written next to names.json
   (also outside the repo) so a re-run gives everyone the same letter.

   Only the anonymised rows are written. The script then lists every
   capitalised word left in the output that is not a common word or a known
   product, so a person can check nothing slipped through before committing. */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./common.js');

const KEEP = ['ID', 'Opportunity', 'Function', 'Process phase', 'Cluster', 'Claude surface', 'Build type', 'Status', 'Problem / pain', 'What Claude does',
  'Systems', 'Source quote', 'Raised by', 'Owner', 'Source', 'Confidence', 'Votes', 'Value (client 1-5)', 'Ease (consultant 1-5)', 'Notes', 'Captured'];
/* Products and common words are not client data. Anything else capitalised
   is reported for a human to check. */
const SAFE = new Set(('I A The An And Or But If When Then For To Of In On At By With From Into Every Each All Any No Not Never Only One Two Three ' +
  'Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December ' +
  'Claude Opus Sonnet Haiku Anthropic Microsoft Excel Outlook SharePoint Teams OneDrive Word PowerPoint Google Gmail Drive Sheets Dropbox Slack ' +
  'NetSuite Xero MYOB SAP Oracle Salesforce HubSpot Notion Zapier Power Automate BI PDF PDFs CSV API AI SKU SKUs PO POs AP AR ERP EDI GST ABN ' +
  'Finance Purchasing Both Org-wide Open Validated Emerging Parked Merged Room Facilitator Participant Consultant High Medium Low Skill Project ' +
  'Scheduled Task Cowork Chat Connector Setup Workflow Redesign Person Client Co Supplier Brand Company').split(/\s+/));

function main() {
  const dir = process.argv[2], mapPath = C.arg('map'), out = C.arg('out', path.join(C.REPO, 'test', 'fixtures', 'sept-exports.anon.json'));
  if (!dir || !mapPath) { console.error('Usage: node scripts/anonymise-fixture.js <exports folder> --map <names.json> [--out file]'); process.exit(1); }
  C.refuseInsideRepo(dir, 'The exports folder');
  C.refuseInsideRepo(mapPath, 'The names file');
  if (!fs.existsSync(mapPath)) { console.error('No names file at ' + mapPath + '. Create it with the company and supplier names to replace: { "replace": { "Real name": "Client Co" } }'); process.exit(1); }
  const map = C.readJSON(mapPath);
  const peoplePath = mapPath.replace(/\.json$/i, '') + '.people.json';
  const people = fs.existsSync(peoplePath) ? C.readJSON(peoplePath) : {};

  const exports = C.readExports(dir);
  const letter = n => 'Person ' + (n < 26 ? String.fromCharCode(65 + n) : 'Z' + n);
  exports.forEach(e => e.rows.forEach(r => ['Raised by', 'Owner'].forEach(k => String(r[k] || '').split(/[,&/]| and /).map(s => s.trim()).forEach(nm => {
    if (!nm || /^(room|facilitator|claude|consultant|ai|everyone|team|tbc|unknown)$/i.test(nm) || people[nm]) return;
    people[nm] = letter(Object.keys(people).length);
  }))));
  C.writeJSON(peoplePath, people);

  /* Longest first, so "Jane Citizen" is replaced before "Jane". First names
     and surnames of each person are replaced on their own too. */
  const pairs = Object.entries(map.replace || {});
  Object.entries(people).forEach(([full, alias]) => {
    pairs.push([full, alias]);
    full.split(/\s+/).filter(p => p.length > 2).forEach(p => pairs.push([p, alias]));
  });
  pairs.sort((a, b) => b[0].length - a[0].length);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = pairs.map(([k, v]) => [new RegExp('\\b' + esc(k) + '(\'s)?\\b', 'gi'), v]);
  const clean = v => { let s = String(v == null ? '' : v); rx.forEach(([r, to]) => { s = s.replace(r, (m, poss) => to + (poss || '')); }); return s; };

  const anon = exports.map(e => ({ name: e.name, client: clean(e.client || ''), teams: clean(e.teams || ''), rows: e.rows.map(r => { const o = {}; KEEP.forEach(k => { if (k in r) o[k] = clean(r[k]); }); return o; }) }));
  C.writeJSON(out, { note: 'Anonymised from real client exports. Names, company and supplier names replaced. Do not add raw exports to this repository.', exports: anon });

  const left = {};
  anon.forEach(e => e.rows.forEach(r => Object.values(r).forEach(v => String(v).split(/[^A-Za-z'-]+/).forEach((w, i) => {
    if (i > 0 && /^[A-Z][a-z]{2,}/.test(w) && !SAFE.has(w) && !SAFE.has(w.replace(/'s$/, ''))) left[w] = (left[w] || 0) + 1;
  }))));
  console.log('Wrote ' + out);
  anon.forEach(e => console.log('  ' + e.name + ': ' + e.rows.length + ' rows'));
  console.log(Object.keys(people).length + ' people replaced (map in ' + peoplePath + ')');
  const list = Object.entries(left).sort((a, b) => b[1] - a[1]);
  console.log('\nCapitalised words left, check each is not a name, company or supplier (' + list.length + '):');
  console.log(list.map(([w, n]) => w + ' ' + n).join(', '));
}
main();
