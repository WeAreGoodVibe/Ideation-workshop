# Prompt changelog

Each job reads the file named in `index.json`. To try a change, copy the file to the next version, edit it, point `index.json` at it, and run `npm run eval` on the fixture before and after.

## extract.v2, second-viewpoint.v2, consolidate.v1 (28 September 2026)

- Live capture classifies every capture into one of eight types and attaches it to an existing Opportunity before creating one. It sees the register as a tree with IDs, not a list of titles.
- The unit test (owner, trigger or frequency, time per round) decides what may be an Opportunity.
- Confidence is a number from 0 to 1; under 0.6 goes to Triage.
- Second viewpoint returns the same capture types, marked Proposed, and may attach missed guardrails, dependencies and questions to existing Opportunities.
- Consolidate is new: it returns the register as it should be, and code turns that into single changes a person approves or rejects.
- The examples inside the prompts are deliberately not the acceptance examples in the test fixture, so the fixture measures the prompt instead of rewarding it for repeating the examples.

## v1 (up to 23 September 2026)

Written inline in `app.js` (`extractPrompt`, `secondPrompt`). A flat list of at most three new opportunities per window, with existing titles only as a "do not repeat" list.
