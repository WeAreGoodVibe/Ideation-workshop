<!-- Session consolidation and migration, version 5. Placeholders in double braces are filled by lib/pipeline.js. -->
You are tidying the opportunity register from an AI opportunity workshop. It was captured live, row by row, so it is too flat. Workflows, their build steps, rules, setup, questions, platform limits, training tips and near-duplicates all sit side by side. Your job is to say what the register should look like: a short list of real workflows, with everything else placed under them or moved out.

A person reviews every change you imply, one at a time, before anything is applied. Be decisive, and give a short reason for anything that is not obvious.

{{context}}

THE REGISTER AS IT IS ({{count}} rows)
Each row: ID | current type | parent | text | phase | owner | systems | problem | what Claude does | notes | evidence
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
- enabler: a platform or organisation-wide limitation that affects two or more workflows and that the client cannot remove by doing the work themselves: a connector that lacks a permission, a system that blocks unattended logins, a plugin IT will not approve. An Enabler makes every workflow it links show as Blocked, so use it only for real limits. Shared glossaries, reference files, libraries, folder structures and naming conventions are work the client can do: place each as a setup_action under the workflow that needs it first, not as an Enabler.
- learning: a way of working or a training point about using Claude. Never a workflow, never counted.

WHAT TO RETURN
1. opportunities: the Opportunities the register should have. Reuse an existing row's ID as key when that row already names the workflow well enough; otherwise propose a new one with key "new1", "new2" and so on, and fill every field you can from the rows. Keep the list short. If two candidate workflows share an owner, a trigger and most of their steps, they are one workflow. Before you answer, count your Opportunities. If there are more than fifteen, find any that share an owner, a trigger and the same output, such as the stages of one month-end close, and merge them. Keep two workflows apart when each produces its own output, even if the same person runs both on the same trigger.
2. placements: exactly one entry for every row in the register above, with no row left out.
   - type: what the row really is.
   - parent: for a child type, the key of the Opportunity it belongs to. For an opportunity row that is the same workflow as another, set duplicateOf to that key. For a row kept as its own Opportunity, parent and duplicateOf are "".
   - duplicateOf: for a row placed as a child type or as learning that says the same thing as another row placed the same way, that other row's ID, whatever type either row has now. Two wordings of one step, rule or tip are one row. Before you answer, go through each Opportunity with more than ten children and each learning module, and mark every repeat.
   - text: for a row that becomes a child, the item rewritten in one short sentence. Otherwise "".
   - module: for learning, the Foundations module in two to four words. Otherwise "".
   - confidence: 0 to 1. Under 0.6 sends the row to a person to sort.
   - reason: one short clause, only when the move is not obvious.
3. enablers: each organisation-wide limitation, with links (the keys of every Opportunity it blocks, at least two), fromIds (the rows it replaces), owner (Client, IT provider or Consultant) and text. A row listed in fromIds gets placement type "enabler". A limit can also be stated only inside other rows (in what Claude does, the problem, or the evidence), with no row of its own: it is still an Enabler. Leave fromIds empty and name the rows that state it in reason.

Australian English. No em dashes.
