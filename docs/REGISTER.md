# The hierarchical register

Work in progress on branch `claude/zen-curie-yb0fce`. Stages 1 and 2 are done: the model, its rules, the prompts and the consolidation pipeline. The page still runs the flat board until stage 5.

## The model

| Level | What it is | ID |
|---|---|---|
| Opportunity | A recurring workflow with an owner, a trigger or frequency, and a time cost per round (the unit test). The only top-level item. | O3 |
| Child | Exactly one of: Build step, Guardrail, Dependency, Setup action, Open question. Always has a parent Opportunity. | O3.2 |
| Enabler | An organisation-wide limitation linked to many Opportunities. | E1 |
| Learning item | A way of working or a training point. Never counted. | L1 |
| Triage | A capture the classifier was not sure about. Not on the register until a person places it. | T1 |

- An Opportunity missing a unit-test field is still created. Each missing field becomes an Open question that closes itself when the field is filled, and the Opportunity shows Needs qualification.
- Status runs Identified, Qualified, In build, Built, In use, plus Parked. **Blocked is never stored**: it shows while an Opportunity has an open Dependency or a linked open Enabler.
- A Proposed Opportunity (from the second viewpoint) only counts once the client confirms it.
- IDs are never reused. A moved or merged item leaves an alias, so an old ID still resolves.

## Where things live

| File | Job |
|---|---|
| `lib/register.js` | Every rule: attach before create, duplicate merge, Enabler detection, Blocked, promote and demote, budget warnings, consolidation changes. Pure, runs in the browser and Node. |
| `lib/pipeline.js` | Builds prompts from `prompts/`, holds the JSON schemas, turns replies into captures or reviewable changes, imports old flat exports. |
| `prompts/` | Versioned prompt files. `index.json` picks the active version. Log every change in `CHANGELOG.md`. |
| `api/extract.js` | New modes `capture`, `second2`, `consolidate` with schemas from `lib/pipeline.js`. |
| `scripts/` | Anonymise real exports, migrate old exports, run the eval. |
| `test/` | `npm test` runs the unit tests. No network. |

Tunable numbers are all in `THRESHOLDS` at the top of `lib/register.js`.

## Migrating old exports

Real exports and the names file stay outside the repository; the scripts refuse otherwise, and `.gitignore` blocks `*.xlsx`.

```
node scripts/anonymise-fixture.js <exports folder> --map <names.json>
node scripts/migrate-flat-export.js plan <fixture or exports folder> --out <scratch folder>
# read review.md, set each change in decisions.json to true or false
node scripts/migrate-flat-export.js apply --out <scratch folder>
npm run eval    # needs ANTHROPIC_API_KEY; runs the fixture three times against test/fixtures/acceptance.json
```
