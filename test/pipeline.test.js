/* Tests for lib/pipeline.js with the model stubbed: prompt building, reply
   handling, export combining and a consolidation round trip. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../lib/register.js');
const P = require('../lib/pipeline.js');

const tpl = name => fs.readFileSync(path.join(__dirname, '..', 'prompts', JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'prompts', 'index.json'), 'utf8'))[name]), 'utf8');
const row = (id, title, extra) => Object.assign({ ID: id, Opportunity: title, Function: 'Finance', 'Process phase': 'Accounts payable', Status: 'Open', Source: 'AI', 'Source quote': 'quote for ' + title, 'Raised by': 'Person A' }, extra || {});

test('every prompt in index.json exists, fills its placeholders and has no dashes', () => {
  ['extract', 'second', 'consolidate'].forEach(k => {
    const t = tpl(k);
    assert.ok(!/[–—]/.test(t), k + ' has an en or em dash');
    const out = P.render(t, { context: 'C', register: 'R', window: 'W', transcript: 'T', rows: 'X', count: 1 });
    assert.ok(!/\{\{\w+\}\}/.test(out), k + ' left a placeholder unfilled');
    assert.ok(!/^<!--/.test(out), k + ' kept its header comment');
  });
});

test('the model sees the register as a tree with IDs', () => {
  const reg = R.empty();
  R.createOpportunity(reg, { title: 'File incoming stock invoices daily', owner: 'AP officer', frequency: 'Daily', timeBand: '15 to 60 min' });
  R.createChild(reg, 'O1', { type: 'guardrail', text: 'Never delete the original email' });
  const d = P.registerDigest(reg);
  assert.match(d, /^O1 File incoming stock invoices daily/);
  assert.match(d, /\n  O1\.1 \[Guardrail\] Never delete the original email/);
  assert.match(P.extractPrompt(tpl('extract'), { context: 'CLIENT: X', register: reg, window: '[10:00] hello' }), /O1\.1 \[Guardrail\]/);
});

test('a reply applies through the register rules', () => {
  const reg = R.empty();
  const res = P.applyReply(reg, { captures: [
    { type: 'opportunity', key: 'new1', text: 'File incoming stock invoices daily', title: 'File incoming stock invoices daily', confidence: 0.9, parentId: '', duplicateOf: '', appliesTo: [], owner: 'AP officer', frequency: 'Daily', timeBand: '15 to 60 min', systems: ['Outlook'], quote: 'every morning I file invoices', speaker: 'Person B', at: '09:14' },
    { type: 'guardrail', key: '', text: 'Never delete the original email', confidence: 0.85, parentId: 'new1', duplicateOf: '', appliesTo: [], quote: 'keep the email', speaker: '', at: '09:15' }
  ] }, { source: 'live' });
  assert.deepEqual(res.map(r => r.action).sort(), ['attached', 'created']);
  assert.equal(R.findOpp(reg, 'O1').evidence[0].at, '09:14');
  assert.equal(R.findOpp(reg, 'O1').evidence[0].speaker, 'Person B');
});

test('combining exports: an earlier export wholly inside a later one is detected and dropped', () => {
  const d21 = { name: '21 Sep', rows: [row('O1', 'Alpha task'), row('O2', 'Beta task')] };
  const d22 = { name: '22 Sep', rows: [row('O1', 'Alpha task'), row('O2', 'Beta task'), row('O3', 'Gamma task')] };
  const d23 = { name: '23 Sep', rows: [row('O1', 'Delta task'), row('O2', 'Gamma task')] };
  const c = P.combineExports([d21, d22, d23]);
  assert.deepEqual(c.subsets, ['21 Sep']);
  assert.equal(c.raw, 5);
  assert.equal(c.exactRepeats, 1);
  assert.deepEqual(c.rows.map(r => r.Opportunity), ['Alpha task', 'Beta task', 'Gamma task', 'Delta task']);
});

test('combining exports: an export for a different client is set aside, not mixed in', () => {
  const c = P.combineExports([
    { name: '21 Sep', client: 'Other Co', rows: [row('O1', 'Answer client emails')] },
    { name: '22 Sep', client: 'Client Co', rows: [row('O1', 'Alpha task'), row('O2', 'Beta task')] },
    { name: '23 Sep', client: 'Client Co', rows: [row('O1', 'Gamma task')] }
  ]);
  assert.equal(c.client, 'Client Co');
  assert.deepEqual(c.otherClient, [{ name: '21 Sep', client: 'Other Co', rows: 1 }]);
  assert.deepEqual(c.subsets, []);
  assert.equal(c.raw, 3);
});

test('flat import: every old row becomes an Opportunity with its quote as evidence, IDs never collide', () => {
  const reg = P.flatRowsToRegister([row('O1', 'Alpha task', { _from: '22 Sep O1' }), row('O1', 'Delta task', { _from: '23 Sep O1', Status: 'Validated' })]);
  assert.equal(reg.opportunities.length, 2);
  assert.deepEqual(reg.opportunities.map(o => o.id), ['O1', 'O2']);
  assert.equal(reg.opportunities[1].status, 'Qualified');
  assert.equal(reg.opportunities[1].legacyRef, '23 Sep O1');
  assert.equal(reg.opportunities[0].evidence[0].quote, 'quote for Alpha task');
  assert.equal(reg.items.length, 0, 'no automatic questions before consolidation');
});

test('consolidation round trip with a stubbed model: rows fold into workflows and unplaced rows are reported', async () => {
  const reg = P.flatRowsToRegister([
    row('O1', 'Build the weekly brand replenishment order'), row('O2', 'Add never-touch rule for images in column B'),
    row('O3', 'Pull eight weeks of sales for the reorder'), row('O4', 'Match invoices to purchase orders'),
    row('O5', 'Switch to Opus when invoice batches exceed daily volume'), row('O6', 'Microsoft 365 connector read-only')
  ]);
  let seen = '';
  const ask = (prompt, mode) => { seen = prompt; assert.equal(mode, 'consolidate'); return {
    opportunities: [{ key: 'O1', title: 'Build the weekly brand replenishment order', owner: 'Brand buyer', frequency: 'Weekly', timeBand: '1 to 4 hours' },
      { key: 'new1', title: 'File incoming stock invoices daily', 'function': 'Finance', phase: 'Accounts payable', owner: 'AP officer', frequency: 'Daily', timeBand: '15 to 60 min', systems: [], problem: '', claudeDoes: '', surface: '', origin: 'Client-raised', reason: '' }],
    placements: [
      { id: 'O1', type: 'opportunity', parent: '', duplicateOf: '', text: '', module: '', confidence: 0.95, reason: '' },
      { id: 'O2', type: 'guardrail', parent: 'O1', duplicateOf: '', text: 'Never touch the images in column B', module: '', confidence: 0.9, reason: '' },
      { id: 'O3', type: 'build_step', parent: 'O1', duplicateOf: '', text: 'Pull eight weeks of sales by SKU', module: '', confidence: 0.9, reason: '' },
      { id: 'O4', type: 'build_step', parent: 'new1', duplicateOf: '', text: 'Match each invoice to its purchase order', module: '', confidence: 0.9, reason: '' },
      { id: 'O5', type: 'learning', parent: '', duplicateOf: '', text: '', module: 'Choosing a model', confidence: 0.9, reason: '' },
      { id: 'O6', type: 'enabler', parent: '', duplicateOf: '', text: '', module: '', confidence: 0.9, reason: '' }
    ],
    enablers: [{ key: '', text: 'Microsoft 365 connector is read-only', owner: 'IT provider', links: ['O1', 'new1'], fromIds: ['O6'], reason: '' }]
  }; };
  const r = await P.consolidate(reg, tpl('consolidate'), ask, { context: 'CLIENT: X' });
  assert.match(seen, /THE REGISTER AS IT IS \(6 rows\)/);
  assert.deepEqual(r.unplaced, []);
  const yes = {}; r.changes.forEach(c => { yes[c.id] = true; });
  const out = R.applyChanges(reg, r.changes, yes);
  assert.ok(out.results.every(x => x.status === 'applied'), JSON.stringify(out.results));
  const g = out.register, s = R.summary(g);
  assert.equal(s.opportunities, 2);
  assert.ok(r.changes.some(c => c.kind === 'qualify' && c.target === 'O1'), 'kept rows get the fields the model filled');
  assert.equal(R.findOpp(g, 'O1').owner, 'Brand buyer');
  assert.equal(R.findOpp(g, 'O1').needsQualification, false);
  assert.equal(s.guardrail, 1);
  assert.equal(g.learning[0].text, 'Switch to Opus when invoice batches exceed daily volume');
  assert.equal(g.enablers[0].links.length, 2);
  assert.equal(R.isBlocked(g, 'O1'), true, 'open Enabler blocks');
  const g2 = R.findItem(g, R.resolve(g, 'O2'));
  assert.equal(g2.text, 'Never touch the images in column B');
  assert.equal(g2.evidence[0].quote, 'quote for Add never-touch rule for images in column B', 'evidence survives the fold');
});

test('schemas list every property as required, as structured output needs', () => {
  const walk = (s, where) => {
    if (s.type === 'object') { assert.deepEqual(Object.keys(s.properties).sort(), s.required.slice().sort(), where); Object.entries(s.properties).forEach(([k, v]) => walk(v, where + '.' + k)); }
    if (s.type === 'array') walk(s.items, where + '[]');
  };
  walk(P.captureSchema(['Finance']), 'capture');
  walk(P.consolidateSchema(['Finance']), 'consolidate');
});

test('September fixture: 21 Sep is a subset of 22 Sep, and 170 rows remain across 22 and 23 Sep', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sept-exports.anon.json'), 'utf8')).exports;
  const c = P.combineExports(fx);
  assert.deepEqual(c.subsets, ['2026-09-21']);
  assert.deepEqual(c.otherClient, []);
  assert.equal(c.raw, 170);
  assert.equal(c.rows.length, 170);
  const reg = P.flatRowsToRegister(c.rows);
  assert.equal(reg.opportunities.length, 170, 'every row imports, none lost');
  assert.ok(!/switzerland|rolex|cartier|watchswiss/i.test(JSON.stringify(fx)), 'no client, brand or domain names in the fixture');
});
