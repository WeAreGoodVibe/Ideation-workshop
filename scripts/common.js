/* Shared by the scripts in this folder: reading old exports, calling Claude
   from Node, and the guard that keeps client files out of the repository. */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('../vendor/xlsx.full.min.js');
const { streamClaude, parseLooseJSON } = require('../api/_lib.js');

const REPO = path.resolve(__dirname, '..');
const insideRepo = p => { const r = path.relative(REPO, path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };

/* Client exports must never sit inside the repository, where a commit could
   carry them off. The scripts refuse rather than warn. */
function refuseInsideRepo(p, what) {
  if (insideRepo(p)) { console.error(what + ' is inside the repository (' + p + '). Keep client files outside it.'); process.exit(2); }
}

/* Every .xlsx in a folder, oldest first by the date in its name. */
function readExports(dir) {
  return fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$')).map(f => {
    const wb = XLSX.read(fs.readFileSync(path.join(dir, f)), { type: 'buffer' });
    const sheet = wb.Sheets['Opportunity Register'] || wb.Sheets[wb.SheetNames[0]];
    const m = f.match(/(\d{4}-\d{2}-\d{2})/);
    /* The Read Me tab opens "AI opportunity workshop: <client>, <teams>". */
    const readMe = wb.Sheets['Read Me'];
    const head = readMe && readMe.A1 ? String(readMe.A1.v || '') : '';
    const cm = head.match(/workshop:\s*(.+?),\s*(.+)$/);
    return { name: m ? m[1] : f, file: f, client: cm ? cm[1].trim() : '', teams: cm ? cm[2].trim() : '', rows: XLSX.utils.sheet_to_json(sheet, { defval: '' }) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
/* A fixture JSON ({ exports: [...] }) or a folder of exports. */
function readInput(p) {
  if (fs.statSync(p).isDirectory()) return readExports(p);
  return JSON.parse(fs.readFileSync(p, 'utf8')).exports;
}

/* One call to Claude, streamed (long replies need it), parsed as JSON. */
async function askJSON(prompt, schema, opts) {
  let text = '';
  const out = await streamClaude(prompt, Object.assign({ schema }, opts || {}), t => { text += t; });
  const stop = await out.done;
  if (stop === 'max_tokens') throw new Error('The reply was cut off at the token ceiling');
  return parseLooseJSON(text);
}

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes('--' + name); }
function writeJSON(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function template(name) {
  const idx = readJSON(path.join(REPO, 'prompts', 'index.json'));
  return fs.readFileSync(path.join(REPO, 'prompts', idx[name]), 'utf8');
}

module.exports = { REPO, insideRepo, refuseInsideRepo, readExports, readInput, askJSON, arg, flag, writeJSON, readJSON, template };
