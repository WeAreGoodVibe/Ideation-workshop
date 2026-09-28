/* Unit tests for lib/register.js. No network, no model: every capture here is
   what the classifier would return, so each rule is tested on its own.
   Run with: npm test */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/register.js');

const ev = (quote, speaker, at) => [{ quote, speaker: speaker || 'Person A', at: at || '10:02', source: 'live' }];
const OPTS = { now: '2026-09-28T00:00:00.000Z' };

function brandRegister() {
  const reg = R.empty();
  R.applyCapture(reg, {
    type: 'opportunity', confidence: 0.9, key: 'new1',
    title: 'Build the weekly brand replenishment order', fn: 'Purchasing', phase: 'Replenishment',
    owner: 'Brand buyer', frequency: 'Weekly, Monday', timeBand: '1 to 4 hours', systems: ['Excel', 'NetSuite'],
    problem: 'Buyers rebuild the order sheet by hand each week.', claudeDoes: 'Drafts the order from stock and sales.',
    evidence: ev('every Monday I rebuild the replenishment sheet from scratch')
  }, OPTS);
  R.applyCapture(reg, {
    type: 'opportunity', confidence: 0.9,
    title: 'File incoming stock invoices daily', fn: 'Finance', phase: 'Accounts payable',
    owner: 'AP officer', frequency: 'Daily', timeBand: '15 to 60 min', systems: ['Outlook', 'SharePoint'],
    problem: 'Invoices arrive by email and are filed by hand.', claudeDoes: 'Reads the inbox and files each invoice.',
    evidence: ev('I spend the first half hour every day filing invoices', 'Person B')
  }, OPTS);
  return reg;
}

test('similarity: identical after normalising is 1, unrelated is low', () => {
  assert.equal(R.similarity('File incoming invoices', 'file  incoming INVOICES!'), 1);
  assert.ok(R.similarity('File incoming stock invoices daily', 'Weekly brand replenishment order') < 0.25);
  assert.ok(R.similarity('File incoming stock invoices daily', 'File the incoming stock invoice each day') > 0.5);
});

test('unit test: a missing owner, trigger or time creates an Opportunity flagged Needs qualification with Open questions', () => {
  const reg = R.empty();
  const r = R.applyCapture(reg, { type: 'opportunity', confidence: 0.9, title: 'Reconcile supplier statements monthly', frequency: 'Monthly', evidence: ev('statements take a day') }, OPTS);
  assert.equal(r.action, 'created');
  const o = R.findOpp(reg, r.id);
  assert.equal(o.needsQualification, true);
  const qs = R.childrenOf(reg, o.id).filter(i => i.type === 'open_question' && i.status === 'Open');
  assert.equal(qs.length, 2, 'owner and time per round are missing');
  o.owner = 'AP lead'; o.timeBand = '1 to 4 hours';
  R.applyCapture(reg, { type: 'opportunity', confidence: 0.9, title: 'Reconcile supplier statements monthly', evidence: ev('the AP lead does it') }, OPTS);
  assert.equal(R.findOpp(reg, o.id).needsQualification, false);
  assert.equal(R.childrenOf(reg, o.id).filter(i => i.type === 'open_question' && i.status === 'Open').length, 0, 'answered questions close themselves');
});

test('attach before create: a build step names its parent and lands as a child, not a new row', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'build_step', confidence: 0.85, parentId: 'O1', text: 'Pull last 8 weeks of sales by SKU', evidence: ev('we look at eight weeks of sales') }, OPTS);
  assert.equal(r.action, 'attached');
  assert.equal(r.id, 'O1.1');
  assert.equal(reg.opportunities.length, 2);
});

test('attach before create: with no parent named, code picks the best-fitting Opportunity', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'guardrail', confidence: 0.8, text: 'Never touch the images in column B of the brand replenishment order sheet', phase: 'Replenishment', evidence: ev('do not touch the pictures in column B') }, OPTS);
  assert.equal(r.action, 'attached');
  assert.equal(R.findItem(reg, r.id).parentId, 'O1');
  assert.equal(R.findItem(reg, r.id).type, 'guardrail');
});

test('attach before create: a child that fits nothing goes to Triage, never to the register', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'build_step', confidence: 0.9, text: 'Schedule forklift maintenance', evidence: ev('forklifts') }, OPTS);
  assert.equal(r.action, 'triaged');
  assert.equal(reg.items.filter(i => !i.auto).length, 0);
});

test('a new Opportunity and its children in one batch: children find it by its temporary key', () => {
  const reg = R.empty();
  const res = R.applyCaptures(reg, [
    { type: 'build_step', confidence: 0.9, parentId: 'new1', text: 'Match invoice to purchase order', evidence: ev('match to the PO') },
    { type: 'opportunity', confidence: 0.9, key: 'new1', title: 'File incoming stock invoices daily', owner: 'AP officer', frequency: 'Daily', timeBand: '15 to 60 min', evidence: ev('filing invoices daily') }
  ], OPTS);
  assert.deepEqual(res.map(r => r.action).sort(), ['attached', 'created']);
  assert.equal(R.childrenOf(reg, 'O1').filter(i => !i.auto).length, 1);
});

test('low confidence goes to Triage', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'build_step', confidence: 0.4, parentId: 'O1', text: 'Maybe something about PDFs', evidence: ev('PDFs maybe') }, OPTS);
  assert.equal(r.action, 'triaged');
  assert.equal(reg.triage.length, 1);
  assert.equal(reg.triage[0].suggestedParent, 'O1');
});

test('duplicate merge: the same Opportunity heard again adds evidence, never a second row', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'opportunity', confidence: 0.9, title: 'File the incoming stock invoices each day', phase: 'Accounts payable', evidence: ev('filing invoices eats my morning', 'Person C', '14:40') }, OPTS);
  assert.equal(r.action, 'merged');
  assert.equal(r.id, 'O2');
  assert.equal(reg.opportunities.length, 2);
  assert.equal(R.findOpp(reg, 'O2').evidence.length, 2);
  assert.equal(R.findOpp(reg, 'O2').evidence[1].speaker, 'Person C');
});

test('duplicate merge: the model can mark a duplicate the words alone would miss', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'opportunity', confidence: 0.9, duplicateOf: 'O1', title: 'Monday reorder for the watch brands', evidence: ev('the Monday reorder') }, OPTS);
  assert.equal(r.action, 'merged');
  assert.equal(reg.opportunities.length, 2);
});

test('duplicate merge: a child heard twice under the same parent keeps one row and both quotes', () => {
  const reg = brandRegister();
  R.applyCapture(reg, { type: 'guardrail', confidence: 0.9, parentId: 'O1', text: 'Never touch the images in column B', evidence: ev('leave column B alone') }, OPTS);
  const r = R.applyCapture(reg, { type: 'guardrail', confidence: 0.9, parentId: 'O1', text: 'Never touch images in column B', evidence: ev('do not change the images in B', 'Person D') }, OPTS);
  assert.equal(r.action, 'merged');
  const g = R.childrenOf(reg, 'O1').filter(i => i.type === 'guardrail');
  assert.equal(g.length, 1);
  assert.equal(g[0].evidence.length, 2);
});

test('duplicate merge: the same quote twice is stored once', () => {
  const reg = brandRegister();
  R.applyCapture(reg, { type: 'opportunity', confidence: 0.9, duplicateOf: 'O2', title: 'x', evidence: ev('I spend the first half hour every day filing invoices', 'Person B') }, OPTS);
  assert.equal(R.findOpp(reg, 'O2').evidence.length, 1);
});

test('Enabler detection: a Dependency the model says applies to two Opportunities becomes one linked Enabler', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'dependency', confidence: 0.9, parentId: 'O1', appliesTo: ['O2'], text: 'Microsoft 365 connector is read-only', enablerOwner: 'IT provider', evidence: ev('the connector cannot write') }, OPTS);
  assert.equal(r.action, 'enabler');
  const e = R.findEnabler(reg, r.id);
  assert.deepEqual(e.links.sort(), ['O1', 'O2']);
  assert.equal(e.owner, 'IT provider');
  assert.equal(reg.items.filter(i => i.type === 'dependency').length, 0);
});

test('Enabler detection: the same Dependency heard under a second Opportunity is lifted into an Enabler in code', () => {
  const reg = brandRegister();
  R.applyCapture(reg, { type: 'dependency', confidence: 0.9, parentId: 'O1', text: 'Microsoft 365 connector is read-only', evidence: ev('cannot write back') }, OPTS);
  assert.equal(reg.enablers.length, 0);
  const r = R.applyCapture(reg, { type: 'dependency', confidence: 0.9, parentId: 'O2', text: 'The Microsoft 365 connector is read only', evidence: ev('it can read but not move files', 'Person B') }, OPTS);
  assert.equal(r.action, 'enabler');
  assert.equal(reg.enablers.length, 1);
  assert.deepEqual(reg.enablers[0].links.sort(), ['O1', 'O2']);
  assert.equal(reg.enablers[0].evidence.length, 2, 'evidence from both is kept');
  assert.equal(reg.items.filter(i => i.type === 'dependency').length, 0, 'the child it replaced is gone');
  assert.equal(R.resolve(reg, 'O1.1'), reg.enablers[0].id, 'the old ID still resolves');
});

test('Enabler detection: an existing Enabler is reused and linked, not duplicated', () => {
  const reg = brandRegister();
  R.applyCapture(reg, { type: 'enabler', confidence: 0.9, appliesTo: ['O1'], text: 'No NetSuite connector', evidence: ev('no NetSuite connector') }, OPTS);
  R.applyCapture(reg, { type: 'enabler', confidence: 0.9, appliesTo: ['O2'], text: 'There is no NetSuite connector', evidence: ev('nothing for NetSuite') }, OPTS);
  assert.equal(reg.enablers.length, 1);
  assert.deepEqual(reg.enablers[0].links.sort(), ['O1', 'O2']);
});

test('Blocked is computed: an open Dependency blocks, closing it unblocks', () => {
  const reg = brandRegister();
  assert.equal(R.displayStatus(reg, R.findOpp(reg, 'O1')), 'Identified');
  const r = R.applyCapture(reg, { type: 'dependency', confidence: 0.9, parentId: 'O1', text: 'Stock report must be shared by the warehouse', owner: 'Warehouse manager', blockedBy: { kind: 'external', ref: 'Warehouse' }, evidence: ev('we wait on the warehouse') }, OPTS);
  assert.equal(R.isBlocked(reg, 'O1'), true);
  assert.equal(R.displayStatus(reg, R.findOpp(reg, 'O1')), 'Blocked');
  assert.equal(R.findOpp(reg, 'O1').status, 'Identified', 'the stored status is untouched');
  R.findItem(reg, r.id).status = 'Done';
  assert.equal(R.isBlocked(reg, 'O1'), false);
});

test('Blocked is computed: an open linked Enabler blocks every linked Opportunity', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'enabler', confidence: 0.9, appliesTo: ['O1', 'O2'], text: 'File move permissions differ between machines', evidence: ev('works on mine, not hers') }, OPTS);
  assert.equal(R.isBlocked(reg, 'O1'), true);
  assert.equal(R.isBlocked(reg, 'O2'), true);
  assert.ok(R.suggestEase(reg, R.findOpp(reg, 'O1')).ease < 3, 'Ease suggestion drops');
  R.findEnabler(reg, r.id).status = 'Done';
  assert.equal(R.isBlocked(reg, 'O1'), false);
  assert.equal(R.suggestEase(reg, R.findOpp(reg, 'O1')), null);
});

test('Blocked: an open Open question does not block', () => {
  const reg = brandRegister();
  R.applyCapture(reg, { type: 'open_question', confidence: 0.9, parentId: 'O1', text: 'Which brands are in scope?', answerBy: 'Head of buying', evidence: ev('which brands?') }, OPTS);
  assert.equal(R.isBlocked(reg, 'O1'), false);
});

test('Learning items never count as Opportunities', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'learning', confidence: 0.9, text: 'Switch to Opus when invoice batches exceed daily volume', module: 'Choosing a model', evidence: ev('use the bigger model for big batches') }, OPTS);
  assert.equal(r.action, 'learning');
  assert.equal(reg.learning.length, 1);
  assert.equal(R.countedOpportunities(reg).length, 2);
});

test('Proposed Opportunities count only once the client confirms them', () => {
  const reg = brandRegister();
  const r = R.applyCapture(reg, { type: 'opportunity', confidence: 0.9, title: 'Chase overdue supplier credit notes weekly', owner: 'AP officer', frequency: 'Weekly', timeBand: '15 to 60 min', evidence: ev('credit notes go missing') }, Object.assign({ origin: 'Proposed', createdBy: 'second viewpoint' }, OPTS));
  assert.equal(R.findOpp(reg, r.id).origin, 'Proposed');
  assert.equal(R.countedOpportunities(reg).length, 2);
  R.findOpp(reg, r.id).confirmed = true;
  assert.equal(R.countedOpportunities(reg).length, 3);
});

test('promote keeps every piece of evidence and logs the change', () => {
  const reg = brandRegister();
  const c = R.applyCapture(reg, { type: 'build_step', confidence: 0.9, parentId: 'O2', text: 'Chase suppliers for missing invoices', evidence: ev('we chase them by phone') }, OPTS);
  R.addEvidence(R.findItem(reg, c.id), ev('chasing takes Fridays', 'Person E'));
  const o = R.promote(reg, c.id, { owner: 'AP officer' }, OPTS);
  assert.equal(o.title, 'Chase suppliers for missing invoices');
  assert.equal(o.evidence.length, 2);
  assert.equal(o.fn, 'Finance', 'inherits the old parent\'s function');
  assert.equal(R.findItem(reg, c.id), null);
  assert.equal(R.resolve(reg, c.id), o.id);
  assert.equal(reg.log.at(-1).action, 'promote');
  assert.equal(reg.log.at(-1).detail.evidence, 2);
});

test('demote folds an Opportunity into another, carrying evidence, children and Enabler links', () => {
  const reg = brandRegister();
  const extra = R.applyCapture(reg, { type: 'opportunity', confidence: 0.9, title: 'Rename invoice PDFs to the naming convention', owner: 'AP officer', frequency: 'Daily', timeBand: 'Under 15 min', evidence: ev('rename every PDF') }, OPTS);
  R.applyCapture(reg, { type: 'guardrail', confidence: 0.9, parentId: extra.id, text: 'Never delete the original email', evidence: ev('keep the email') }, OPTS);
  const en = R.applyCapture(reg, { type: 'enabler', confidence: 0.9, appliesTo: [extra.id, 'O1'], text: 'File move permissions differ between machines', evidence: ev('permissions') }, OPTS);
  const child = R.demote(reg, extra.id, 'O2', 'build_step', OPTS);
  assert.equal(child.parentId, 'O2');
  assert.equal(child.type, 'build_step');
  assert.equal(child.evidence[0].quote, 'rename every PDF');
  assert.equal(R.findOpp(reg, extra.id), null);
  assert.ok(R.childrenOf(reg, 'O2').some(i => i.type === 'guardrail' && i.text === 'Never delete the original email'), 'its children move too');
  assert.deepEqual(R.findEnabler(reg, en.id).links.sort(), ['O1', 'O2']);
  assert.equal(R.resolve(reg, extra.id), child.id);
  assert.equal(reg.log.at(-1).action, 'demote');
});

test('promote then demote round trip loses no evidence', () => {
  const reg = brandRegister();
  const c = R.applyCapture(reg, { type: 'build_step', confidence: 0.9, parentId: 'O1', text: 'Check open purchase orders before ordering', evidence: ev('check what is already on order') }, OPTS);
  const o = R.promote(reg, c.id, null, OPTS);
  const back = R.demote(reg, o.id, 'O1', 'build_step', OPTS);
  assert.deepEqual(back.evidence.map(e => e.quote), ['check what is already on order']);
});

test('budget warnings: too many Opportunities and too few children', () => {
  const reg = R.empty();
  for (let i = 0; i < 16; i++) R.createOpportunity(reg, { title: 'Workflow number ' + i + ' ' + 'abcdefghijklmnop'[i], owner: 'x', frequency: 'Daily', timeBand: 'Under 15 min' });
  const codes = R.warnings(reg).map(w => w.code);
  assert.ok(codes.includes('too_many'));
  assert.ok(codes.includes('too_flat'));
  const ok = brandRegister();
  ['a', 'b', 'c', 'd'].forEach(x => R.applyCapture(ok, { type: 'build_step', confidence: 0.9, parentId: 'O1', text: 'Step ' + x + ' of the order ' + x.repeat(6) }, OPTS));
  ['a', 'b', 'c'].forEach(x => R.applyCapture(ok, { type: 'build_step', confidence: 0.9, parentId: 'O2', text: 'Filing step ' + x + ' ' + x.repeat(6) }, OPTS));
  assert.deepEqual(R.warnings(ok), []);
});

test('consolidation: planned changes apply only when approved, one by one', () => {
  const reg = R.empty();
  ['Build the weekly brand replenishment order', 'Add never-touch rule for images in column B', 'Weekly reorder for brands', 'Microsoft 365 connector read-only', 'Switch to Opus when invoice batches exceed daily volume', 'File incoming stock invoices daily', 'Rename invoice PDFs on filing']
    .forEach((t, i) => R.createOpportunity(reg, { title: t, evidence: ev('quote ' + i) }, { createdBy: 'migration' }));
  const proposal = {
    opportunities: [{ key: 'O1', title: 'Build the weekly brand replenishment order' }, { key: 'O6', title: 'File incoming stock invoices daily' }],
    placements: [
      { id: 'O1', type: 'opportunity', parent: '', duplicateOf: '', confidence: 0.95 },
      { id: 'O2', type: 'guardrail', parent: 'O1', duplicateOf: '', confidence: 0.9, text: 'Never touch the images in column B' },
      { id: 'O3', type: 'opportunity', parent: '', duplicateOf: 'O1', confidence: 0.9 },
      { id: 'O4', type: 'enabler', parent: '', confidence: 0.9 },
      { id: 'O5', type: 'learning', parent: '', confidence: 0.9, module: 'Choosing a model' },
      { id: 'O6', type: 'opportunity', parent: '', confidence: 0.95 },
      { id: 'O7', type: 'build_step', parent: 'O6', confidence: 0.9 }
    ],
    enablers: [{ key: '', text: 'Microsoft 365 connector is read-only', owner: 'IT provider', links: ['O1', 'O6'], fromIds: ['O4'] }]
  };
  const changes = R.planChanges(reg, proposal);
  const kinds = changes.map(c => c.kind);
  assert.deepEqual(kinds, ['demote', 'merge', 'learning', 'demote', 'enabler']);
  changes.forEach(c => { const d = R.describe(reg, c); assert.ok(d.before && d.after, c.kind + ' has a before and after'); });

  const none = R.applyChanges(reg, changes, {});
  assert.equal(none.register.opportunities.length, 7, 'nothing applied without approval');
  assert.ok(none.results.every(r => r.status === 'rejected'));

  const all = {}; changes.forEach(c => { all[c.id] = true; });
  const out = R.applyChanges(reg, changes, all);
  assert.ok(out.results.every(r => r.status === 'applied'), JSON.stringify(out.results));
  const g = out.register;
  assert.deepEqual(g.opportunities.map(o => o.id), ['O1', 'O6']);
  assert.equal(R.resolve(g, 'O4'), g.enablers[0].id, 'the mis-filed row became the Enabler');
  assert.equal(R.findItem(g, R.resolve(g, 'O2')).type, 'guardrail');
  assert.equal(R.findItem(g, R.resolve(g, 'O2')).parentId, 'O1');
  assert.equal(R.findOpp(g, 'O1').evidence.length, 2, 'the duplicate row became evidence');
  assert.equal(g.learning.length, 1);
  assert.equal(g.enablers.length, 1);
  assert.deepEqual(g.enablers[0].links.sort(), ['O1', 'O6']);
});

test('consolidation: a demoted row marked as a duplicate merges into the other demoted row', () => {
  const reg = R.empty();
  ['Reconcile supplier statements monthly', 'Create the Statements project with the supplier list', 'Set up a Statements project holding the supplier list', 'Export the ledger to CSV']
    .forEach((t, i) => R.createOpportunity(reg, { title: t, evidence: ev('quote ' + i) }, { createdBy: 'migration' }));
  const changes = R.planChanges(reg, {
    opportunities: [{ key: 'O1', title: 'Reconcile supplier statements monthly' }],
    placements: [
      { id: 'O1', type: 'opportunity', confidence: 0.95 },
      { id: 'O2', type: 'setup_action', parent: 'O1', confidence: 0.9, text: 'Create the Statements project with the supplier list' },
      { id: 'O3', type: 'setup_action', parent: 'O1', duplicateOf: 'O2', confidence: 0.9, text: 'Set up a Statements project holding the supplier list' },
      { id: 'O4', type: 'build_step', parent: 'O1', confidence: 0.9 }
    ]
  });
  assert.deepEqual(changes.map(c => c.kind), ['demote', 'demote', 'demote', 'merge']);
  const merge = changes[3];
  assert.deepEqual(merge.requires, [changes[1].id, changes[0].id], 'the merge waits for both demotes');
  const all = {}; changes.forEach(c => { all[c.id] = true; });
  const out = R.applyChanges(reg, changes, all);
  assert.ok(out.results.every(r => r.status === 'applied'), JSON.stringify(out.results));
  const kids = R.childrenOf(out.register, 'O1').filter(i => !i.auto);
  assert.equal(kids.filter(i => i.type === 'setup_action').length, 1);
  assert.equal(R.resolve(out.register, 'O3'), R.resolve(out.register, 'O2'), 'the old ID still resolves');
  assert.equal(R.findItem(out.register, R.resolve(out.register, 'O2')).evidence.length, 2, 'evidence kept');
  const d = {}; changes.forEach(c => { d[c.id] = c !== changes[0]; });
  const partial = R.applyChanges(reg, changes, d);
  assert.equal(partial.results[3].status, 'skipped', 'no merge if its target was never demoted');
});

test('consolidation: siblings worded almost the same become a proposed merge, even if the model missed it', () => {
  const reg = R.empty();
  ['Reconcile supplier statements monthly', 'Load the supplier master list into the Statements project', 'Load the supplier master list as Statements project context', 'Load the ledger export']
    .forEach((t, i) => R.createOpportunity(reg, { title: t, evidence: ev('quote ' + i) }, { createdBy: 'migration' }));
  const changes = R.planChanges(reg, {
    opportunities: [{ key: 'O1', title: 'Reconcile supplier statements monthly' }],
    placements: [
      { id: 'O1', type: 'opportunity', confidence: 0.95 },
      { id: 'O2', type: 'setup_action', parent: 'O1', confidence: 0.9 },
      { id: 'O3', type: 'setup_action', parent: 'O1', confidence: 0.9 },
      { id: 'O4', type: 'build_step', parent: 'O1', confidence: 0.9 }
    ]
  });
  const merges = changes.filter(c => c.kind === 'merge');
  assert.equal(merges.length, 1, 'only the same-type pair');
  assert.equal(merges[0].target, 'O3'); assert.equal(merges[0].into, 'O2');
  assert.match(merges[0].reason, /similarity/);
  const d = {}; changes.forEach(c => { d[c.id] = c.kind !== 'merge'; });
  const kept = R.applyChanges(reg, changes, d).register;
  assert.equal(R.childrenOf(kept, 'O1').filter(i => i.type === 'setup_action').length, 2, 'a rejected merge keeps both');
});

test('consolidation: learning rows marked as repeats end up as one Learning item, and a loop does not break it', () => {
  const reg = R.empty();
  ['Reconcile supplier statements monthly', 'Keep a prompt library for the team', 'Store shared prompts in one team folder', 'Use dictation for long prompts']
    .forEach((t, i) => R.createOpportunity(reg, { title: t, evidence: ev('quote ' + i) }, { createdBy: 'migration' }));
  const changes = R.planChanges(reg, {
    opportunities: [{ key: 'O1', title: 'Reconcile supplier statements monthly' }],
    placements: [
      { id: 'O1', type: 'opportunity', confidence: 0.95 },
      { id: 'O2', type: 'learning', duplicateOf: 'O3', module: 'Sharing prompts', confidence: 0.9 },
      { id: 'O3', type: 'learning', duplicateOf: 'O2', module: 'Sharing prompts', confidence: 0.9 },
      { id: 'O4', type: 'learning', module: 'Voice prompting', confidence: 0.9 }
    ]
  });
  const all = {}; changes.forEach(c => { all[c.id] = true; });
  const out = R.applyChanges(reg, changes, all);
  assert.ok(out.results.every(r => r.status === 'applied'), JSON.stringify(out.results));
  assert.equal(out.register.learning.length, 2);
  assert.equal(R.resolve(out.register, 'O2'), R.resolve(out.register, 'O3'));
});

test('consolidation: rejecting a proposed new Opportunity skips the changes that need it', () => {
  const reg = R.empty();
  R.createOpportunity(reg, { title: 'Match invoice to purchase order' });
  R.createOpportunity(reg, { title: 'Save invoice to the supplier folder' });
  const changes = R.planChanges(reg, {
    opportunities: [{ key: 'new1', title: 'File incoming stock invoices daily', owner: 'AP officer', frequency: 'Daily', timeBand: '15 to 60 min' }],
    placements: [
      { id: 'O1', type: 'build_step', parent: 'new1', confidence: 0.9 },
      { id: 'O2', type: 'build_step', parent: 'new1', confidence: 0.9 }
    ]
  });
  assert.deepEqual(changes.map(c => c.kind), ['create', 'demote', 'demote']);
  const d = {}; changes.forEach(c => { d[c.id] = c.kind !== 'create'; });
  const out = R.applyChanges(reg, changes, d);
  assert.deepEqual(out.results.map(r => r.status), ['rejected', 'skipped', 'skipped']);
  assert.equal(out.register.opportunities.length, 2);
  changes.forEach(c => { d[c.id] = true; });
  const ok = R.applyChanges(reg, changes, d).register;
  assert.equal(ok.opportunities.length, 1);
  assert.equal(R.childrenOf(ok, ok.opportunities[0].id).filter(i => !i.auto).length, 2);
});
