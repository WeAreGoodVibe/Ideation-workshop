# The hierarchical register

Starting a new session on this? Read `docs/REGISTER-HANDOVER.md` first.

On branch `claude/zen-curie-yb0fce`. Stages 1 to 5 are done: the model, its rules, the prompts, the eval, the database, and the page. The page runs the register for every workshop; the flat board is gone.

## The page (stage 5)

| Screen | What changed |
|---|---|
| Register (was Opportunities) | One card per workflow, detail folded underneath by type, Blocked and Needs qualification worked out. Tabs for Enablers, Learning, To sort and, after a consolidation, Review changes. |
| Live capture | Reads with the `capture` prompt: attach before create, low confidence to To sort. A window is saved as one change. |
| Second viewpoint | Writes Proposed workflows and missed detail into the register. A Proposed workflow counts once someone presses Client confirms. |
| Consolidate session | Claude proposes the tidy register; each change is ticked or not, then applied. The server stops a call at 5 minutes, so a register over about 90 rows may be cut off: use the migration script for a large old export. |
| Prompts and skills | Each pack now sees the workflow's build steps, guardrails, dependencies, setup and open questions. |
| Export | Opportunity Register (one row per workflow; ID and Opportunity keep their names so the migration script still reads it), Workflow Detail, Enablers, Learning Backlog, To Sort, then the tabs as before. |

- Every change goes through `change()` in `app.js`, which saves the difference with `SB.saveRegister`, one change at a time. A new row's database id is carried into the next save so nothing is inserted twice.
- Participants cannot write the register tables. Their ideas go in as plain Opportunity rows and their votes as before; the register reads both.
- An old saved board in a browser (flat ideas in localStorage) is turned into Opportunities the first time the page loads it.

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
| `lib/store.js` | Database rows to register and back. `diff` returns the writes in a safe order: parents before children, children moved before an old parent is deleted, votes moved before a merged Opportunity goes. |
| `lib/pipeline.js` | Builds prompts from `prompts/`, holds the JSON schemas, turns replies into captures or reviewable changes, imports old flat exports. |
| `prompts/` | Versioned prompt files. `index.json` picks the active version. Log every change in `CHANGELOG.md`. |
| `api/extract.js` | New modes `capture`, `second2`, `consolidate` with schemas from `lib/pipeline.js`. |
| `sb.js` | `loadRegister()` and `saveRegister(before, after)`. Register tables raise a `register` event; the page reloads the register on it. |
| `supabase/migration-003-register.sql` | Applied to the live project on 28 September 2026 as `hierarchical_register`, `register_revoke_trigger_rpc` and `register_keep_ids_and_move_votes`. Undo: `migration-003-register-undo.sql`. |
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

## The database (migration 003)

Additive. Nothing the flat board reads or writes changed.

- `opportunities` gained `frequency`, `time_band`, `origin`, `confirmed`, `evidence`, `created_via`, `legacy_ref`. Its status check accepts both the old and the new values; existing rows keep Open until the page moves over.
- New tables: `register_items`, `enablers`, `enabler_links`, `learning_items`, `triage_items`, `register_aliases`, `register_log`, `register_counters`.
- `opportunity_blocked` is a view. Blocked is never stored.
- Numbers come from `register_counters` and only go up. A number the page passes in is kept, so O3.2 on screen is O3.2 after a reload.
- A child takes its workshop from its Opportunity, and an Enabler link must join one workshop, so row level security cannot be sidestepped by pointing at another workshop's rows.
- `register_move_votes(from, to)` moves votes when an Opportunity is merged or folded; facilitators only.
- Members read, facilitators write. Participants still add ideas through the existing `opportunities` policies.
- `notes` (the existing column) is now read and written by the register. A merged or demoted Opportunity's notes are appended to the one that survives, labelled with the old ID.
- An Opportunity from before this change gets its Open questions for a missing owner, trigger or time the first time a register change touches it.
