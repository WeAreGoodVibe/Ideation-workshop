<!-- Session consolidation and migration, version 1. Placeholders in double braces are filled by lib/pipeline.js. -->
You are tidying the opportunity register from an AI opportunity workshop. It was captured live, row by row, so it is too flat. Workflows, their build steps, rules, setup, questions, platform limits, training tips and near-duplicates all sit side by side. Your job is to say what the register should look like: a short list of real workflows, with everything else placed under them or moved out.

A person reviews every change you imply, one at a time, before anything is applied. Be decisive, and give a short reason for anything that is not obvious.

{{context}}

THE REGISTER AS IT IS ({{count}} rows)
Each row: ID | current type | parent | text | phase | owner | systems | problem | what Claude does | evidence
{{rows}}

THE UNIT TEST
A real Opportunity is a recurring workflow with an owner (person or role), a trigger or frequency, and a time cost per round that can be estimated. A typical three-day engagement has between ten and fifteen. Most rows are not Opportunities. If a workflow is clearly real but one of the three is unknown, keep it as an Opportunity and leave the field empty.

TYPES
- opportunity: a recurring workflow. Title: verb plus object, the whole workflow ("Reconcile supplier statements monthly").
- build_step: a capability the workflow must include.
- guardrail: a rule the workflow must never break. Phrased as a negative: "Never ...".
- dependency: something outside this workflow that blocks it.
- setup_action: one-off configuration for one workflow: folders, naming conventions, reference files.
- open_question: an unresolved decision.
- enabler: a platform or organisation-wide limitation that affects two or more workflows.
- learning: a way of working or a training point about using Claude. Never a workflow, never counted.

WHAT TO RETURN
1. opportunities: the Opportunities the register should have. Reuse an existing row's ID as key when that row already names the workflow well enough; otherwise propose a new one with key "new1", "new2" and so on, and fill every field you can from the rows. Keep the list short. If two candidate workflows share an owner, a trigger and most of their steps, they are one workflow.
2. placements: exactly one entry for every row in the register above, with no row left out.
   - type: what the row really is.
   - parent: for a child type, the key of the Opportunity it belongs to. For an opportunity row that is the same workflow as another, set duplicateOf to that key. For a row kept as its own Opportunity, parent and duplicateOf are "".
   - duplicateOf: for a child row that repeats another row at the same level, that row's ID.
   - text: for a row that becomes a child, the item rewritten in one short sentence. Otherwise "".
   - module: for learning, the Foundations module in two to four words. Otherwise "".
   - confidence: 0 to 1. Under 0.6 sends the row to a person to sort.
   - reason: one short clause, only when the move is not obvious.
3. enablers: each organisation-wide limitation, with links (the keys of every Opportunity it blocks, at least two), fromIds (the rows it replaces), owner (Client, IT provider or Consultant) and text. A row listed in fromIds gets placement type "enabler".

Australian English. No em dashes.
