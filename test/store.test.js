/* lib/store.js: rows to register and back, and the order writes run in. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/register.js');
const ST = require('../lib/store.js');

const rows = () => ({
  opportunities: [
    { id: 'u1', seq: 1, title: 'File incoming stock invoices daily', fn: 'Finance', owner: 'AP officer', frequency: 'Daily', time_band: '15 to 60 min', systems: ['Outlook'], pain: 'p', direction: 'd', status: 'Identified', origin: 'Client-raised', confirmed: true, evidence: [{ quote: 'q1', speaker: 'Person A', at: '09:00', source: 'live' }] },
    { id: 'u2', seq: 2, title: 'Rename invoice PDFs daily', fn: 'Finance', owner: 'AP officer', frequency: 'Daily', time_band: 'Under 15 min', systems: [], status: 'Open', quote: 'old quote', raised_by: 'Person B', evidence: [] }
  ],
  register_items: [{ id: 'i1', opportunity_id: 'u2', seq: 1, type: 'guardrail', text: 'Never delete the original email', status: 'Open', evidence: [], auto: '' }],
  enablers: [{ id: 'e1', seq: 1, text: 'File move permissions differ between machines', owner: 'IT provider', status: 'Open', evidence: [] }],
  enabler_links: [{ enabler_id: 'e1', opportunity_id: 'u2' }],
  learning_items: [], triage_items: [], register_aliases: [], register_log: [],
  tallies: { u2: { total: 3, names: ['Person A'] } }
});

test('rows become a register with the IDs people see', () => {
  const reg = ST.fromRows(rows());
  assert.deepEqual(reg.opportunities.map(o => o.id), ['O1', 'O2']);
  assert.equal(reg.items[0].id, 'O2.1');
  assert.deepEqual(reg.enablers[0].links, ['O2']);
  assert.equal(R.isBlocked(reg, 'O2'), true);
  assert.equal(reg.opportunities[1].evidence[0].quote, 'old quote', 'a flat row keeps its one quote as evidence');
  assert.equal(reg.opportunities[1].votes, 3);
});

test('no change, no writes', () => {
  const reg = ST.fromRows(rows());
  assert.deepEqual(ST.diff(reg, R.clone(reg)), []);
});

test('a new child is one insert naming its parent by register ID', () => {
  const before = ST.fromRows(rows()), after = R.clone(before);
  R.applyCapture(after, { type: 'build_step', confidence: 0.9, parentId: 'O1', text: 'Match invoice to purchase order', evidence: [{ quote: 'match the PO' }] });
  const ops = ST.diff(before, after);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'insert');
  assert.equal(ops[0].row.opportunity_ref, 'O1');
  assert.equal(ops[0].row.seq, 1);
});

test('folding O2 into O1: children move, votes move, then O2 is deleted, in that order', () => {
  const before = ST.fromRows(rows()), after = R.clone(before);
  R.demote(after, 'O2', 'O1', 'build_step');
  const ops = ST.diff(before, after);
  const at = (pred) => ops.findIndex(pred);
  const moveChild = at(o => o.table === 'register_items' && o.op === 'update' && o.uid === 'i1');
  const moveVotes = at(o => o.op === 'moveVotes');
  const delOpp = at(o => o.table === 'opportunities' && o.op === 'delete' && o.uid === 'u2');
  const link = at(o => o.op === 'link' && o.opp === 'O1');
  assert.ok(moveChild >= 0 && moveVotes >= 0 && delOpp >= 0 && link >= 0, JSON.stringify(ops));
  assert.ok(moveChild < delOpp, 'the child moves before its old parent is deleted');
  assert.ok(moveVotes < delOpp, 'votes move before the Opportunity is deleted');
  assert.equal(ops[moveChild].row.opportunity_ref, 'O1');
  assert.equal(ops[moveVotes].to, 'O1');
  assert.ok(!ops.some(o => o.op === 'unlink'), 'links of a deleted Opportunity go with it');
  assert.ok(ops.some(o => o.table === 'register_aliases' && o.row.old_ref === 'O2'));
  assert.ok(ops.some(o => o.table === 'register_log' && o.row.action === 'demote'));
});

test('an updated field writes only that field', () => {
  const before = ST.fromRows(rows()), after = R.clone(before);
  R.findOpp(after, 'O1').status = 'Qualified';
  assert.deepEqual(ST.diff(before, after), [{ table: 'opportunities', op: 'update', uid: 'u1', id: 'O1', row: { status: 'Qualified' } }]);
});

test('notes load from the database and a changed note writes only that field', () => {
  const r = rows(); r.opportunities[0].notes = 'Only one machine could move files.';
  const reg = ST.fromRows(r);
  assert.equal(reg.opportunities[0].notes, 'Only one machine could move files.');
  const after = R.clone(reg); after.opportunities[0].notes += ' Check the others.';
  const ops = ST.diff(reg, after);
  assert.equal(ops.length, 1);
  assert.deepEqual(Object.keys(ops[0].row), ['notes']);
});
