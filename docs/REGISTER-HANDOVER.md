# Handover: the hierarchical register

Updated 29 September 2026. Read this first in a new session about the register work. For the product as a whole (hosting, Supabase, roles, the workshop flow), read `docs/HANDOVER.md`. For how the register itself works, read `docs/REGISTER.md`.

## Paste this into the new conversation

```
Continue the hierarchical register work on branch claude/zen-curie-yb0fce in
WeAreGoodVibe/Ideation-workshop. Read docs/REGISTER-HANDOVER.md first, then
docs/REGISTER.md. Stages 1 to 5 are done and pushed. One decision is open:
prompt v5 or back to v3 (section "The open decision"). Do not merge to main
until the checks in "Before this goes live" pass. Do not change prompts,
thresholds or acceptance criteria without showing me the before and after.
Style: Australian English, no em or en dashes, short chunks under bold
specific headings, tables where they help. I am dyslexic and have ADHD.
```

## Where things stand

| Item | State |
|---|---|
| Branch | `claude/zen-curie-yb0fce`, pushed. Latest commit: "Move the page onto the hierarchical register". |
| Live site | **Live since 29 September 2026** at https://ideation-workshop-three.vercel.app. Merged before the seven checks, then Max ran them on the live site the same day and everything looked right. |
| Stage 1 and 2 | Model, rules, versioned prompts, consolidation pipeline. Done. |
| Stage 3 | The eval. Runs, but the prompt decision below is still open. |
| Stage 4 | Database migration 003. Applied to the live Supabase project on 28 September. Additive only. |
| Stage 5 | The page runs the register for every workshop. Done and pushed. Tested locally only. |
| Unit tests | 45 of 45 pass (`npm test`). |

## The open decision

**Update, 28 September, 4:30pm: v5 was approved and run. It passed 2 of 3, the same as v3, and is active in `prompts/index.json`. The open question is now whether to stop tuning the prompt and add a warning to the review screen instead (see the eval history). The v4 notes below are kept for the record.**

**v4 was active in `prompts/index.json`, and it is the weakest of the recent versions.**

| Version | Runs passed | What went wrong |
|---|---|---|
| v3 | 2 of 3 | One run split payroll into 3 workflows (19 total, target 12 to 16) |
| v4 | 1 of 3 | Two runs merged "store arrival summaries" into invoice filing (O17 held 41 to 43% of all detail, limit 40%) |

**Why v4 failed:** its new rule merges workflows that share an owner and a trigger. Arrival summaries and invoice filing are both done daily by Person E, but they produce different outputs.

**Proposed v5.** Only this sentence in `prompts/consolidate.v4.md` changes.

- Before: "...find any that share an owner and a trigger, such as the stages of one month-end close, and merge them."
- After: "...find any that share an owner, a trigger and the same output, such as the stages of one month-end close, and merge them. Keep two workflows apart when each produces its own output, even if the same person runs both on the same trigger."

**Steps once Max decides:**

1. **If v5:**
   1. Copy `consolidate.v4.md` to `consolidate.v5.md` and change that sentence.
   2. Point `prompts/index.json` at the new file.
   3. Add a `CHANGELOG.md` entry.
   4. Run `npm run eval`.
   5. Report per run.
2. **If v3:** point `prompts/index.json` back at `consolidate.v3.md`, log it in the changelog, and re-run the eval to confirm.

## How to run the eval

- It needs a Claude API key. `ANTHROPIC_API_KEY` is not set in these cloud sessions. `EVAL_ANTHROPIC_API_KEY` is, and Max confirmed on 28 September it is his to use. Pass it to the one command only, and never print it: `ANTHROPIC_API_KEY="$EVAL_ANTHROPIC_API_KEY" npm run eval -- --out <scratch folder>`
- **Time and cost:** 3 runs at about 8 minutes each. Run it in the background.
- **Free replays:** any saved reply can be replayed through changed code with no API call, using `node scripts/eval-fixture.js --runs 1 --proposal <run folder>/proposal.json --out <folder>`. Use this to test code changes before paying for a real run.
- **Saved runs are lost.** Scratchpad folders do not survive the session, so this session's run folders are gone. The numbers are in the history table below.

## Eval history (all on the September fixture)

| Eval | Prompt | Passed | Main finding |
|---|---|---|---|
| 1 | v1 | 0 of 3 | Duplicate rows every run. The M365 check passed falsely on a mailbox Enabler. |
| 2 | v2 | 1 run done, then stopped | Duplicates fixed. The M365 limit was still missed, because the import dropped the Notes column. |
| 3 | v3 | 2 of 3 | M365 limit found in all 3 runs. One run made 19 workflows. |
| 4 | v4 | 1 of 3 | 15 workflows every run, but O17 swallowed a separate workflow in 2 runs. |
| 5 | v5 | 2 of 3 | 15 workflows and the M365 Enabler in every run. One run still folded arrival summaries into O17 (43%). |

**Fixes that came out of these evals:**

- **Code bug:** the model's duplicate marks were thrown away in migrations. Fixed.
- **Data loss:** the Notes column was dropped on import. Fixed in the import, the prompt rows and `lib/store.js`.
- **Criteria:** the M365 check was too loose, then too strict. Now it needs a file operation.
- **New checks:** duplicate Learning items, and no workflow over 40% of the detail.
- **Dropped check:** the Blocked-share check, because unattended logins genuinely block most workflows.

The side-by-side results page for eval 3 is at https://claude.ai/artifact/GSQ6baTMK3f2WrRJNJeV3C (private to Max).

## Before this goes live

**Done.** Merged to `main` on 29 September 2026 before these checks, then Max ran them on the live site the same day and reported that everything looked right. Keep the list for the next large change.

Every stage 5 test before the merge used a local page with simulated Claude replies and a fake backend.

1. **Open a Vercel preview of this branch and sign in as a facilitator.** Open a test workshop, not a client one.
2. **Check a register loads.** Old flat opportunities should appear as workflows, with Needs qualification showing.
3. **Add a workflow, add detail, merge two, then reload.** Everything should still be there, with no duplicates.
4. **Join on a phone as a participant.** Add an idea and vote. Check it shows for the facilitator.
5. **Run live capture on a short pasted transcript.** Check detail lands under a workflow and that To sort works.
6. **Run Consolidate session on a small register (under 90 rows).** Tick a few changes, apply them, and reload.
7. **Export the Excel file.** Check the new tabs: Workflow Detail, Enablers, Learning Backlog and To Sort.
8. **Merge to `main` only after all seven pass.** Production tracks `main`, so the merge is the release.

## Known limits

| Limit | What to do |
|---|---|
| The server stops an AI call at 5 minutes. A 170-row consolidation took 7 to 8. | The page warns above 90 rows. For a large old export, use `scripts/migrate-flat-export.js`. Raising `maxDuration` in `vercel.json` depends on the Vercel plan. |
| A moved detail is re-inserted with a new database row, not updated in place. | Harmless: the text, type and evidence are kept. Only the row's database id changes. |
| Notes on a row that becomes an Enabler or a Learning item are not kept. | Evidence quotes are kept. Small gap, out of scope so far. |
| Table mode on the old Opportunities view was removed. | Cards only now. Say if the spreadsheet-style edit is missed. |

## Decisions already made (do not reopen)

- **Replace outright.** There is no switch between the flat board and the register; every workshop gets the register.
- **Stage 5 built everything in one go:** tree, review, live capture, second viewpoint, voting and export.
- **Enablers are real limits only.** Glossaries, shared libraries and naming conventions are Setup actions.
- **Proposed workflows count only once someone presses Client confirms.**
- **Every consolidation change needs a tick** before it is applied. Nothing is applied silently.
- **Prompt examples never repeat the acceptance examples,** so the fixture tests the prompt rather than rewarding it for copying.

## Files touched in stages 3 to 5

| File | What changed |
|---|---|
| `lib/register.js` | Keeps duplicate marks through demotes, adds a similarity safety net, merges Learning repeats, carries notes on merge and fold, exports `syncQualification`. |
| `lib/pipeline.js` | Imports Notes and shows them to consolidation. |
| `lib/store.js` | Reads and writes `notes` and `createdAt`. |
| `sb.js` | `saveRegister` writes new database ids back so the page never inserts a row twice. |
| `app.js` | The register UI, the save queue, live capture, second viewpoint, consolidation review and export. |
| `styles.css`, `index.html`, `help.js` | Register styling, the nav label "Register", the help text. |
| `prompts/` | `consolidate.v2.md` to `v4.md`, each logged in `CHANGELOG.md`. |
| `test/` | New tests for duplicates, Learning repeats, notes and store round trips. The acceptance criteria are in `test/fixtures/acceptance.json`. |

## One housekeeping note

The session that did this work was assigned branch `claude/cool-sagan-aqd28q`. All work went to `claude/zen-curie-yb0fce` instead, because Max asked for that branch by name. `cool-sagan` has nothing on it.
