/* ============================================================================
   seed.js: everything the workshop starts with.
   Client context, the run sheet, the question bank, the process phases, the
   assumed systems, the consultant blind-spot ideas, and a demo transcript so
   the whole loop can be tested without a live meeting.

   Nothing here is a fact about Watches of Switzerland until the room confirms
   it. Every system is tagged "assumed" on purpose; the first job of the
   workshop is to turn assumed into confirmed.
   ========================================================================== */
window.SEED = (function () {

  var client = {
    name: 'Watches of Switzerland',
    short: 'WoS',
    functions: ['Finance', 'Purchasing'],
    headcount: 8,
    northStar: 'Hours returned to the team each month at constant headcount',
    scopeCriterion: 'Does this have an automation or intelligence core that Claude can carry?',
    aiPlatform: 'Claude (Team or Enterprise plan)'
  };

  /* The five Claude surfaces, in the words the room will hear. Each one has a
     tell: the sentence that, when someone says it, means this surface fits. */
  var surfaces = [
    { key: 'Claude Chat',     tell: 'a one-off: draft, summarise, explain, compare', build: 'No build. Show them the prompt pattern.' },
    { key: 'Claude Project',  tell: 'the same context every time: policies, templates, a system export', build: 'Setup: a Project with instructions and the reference files loaded.' },
    { key: 'Scheduled Task',  tell: 'every Monday / every month-end / whenever this arrives', build: 'Scheduled task: a prompt on a timer with the connectors it needs.' },
    { key: 'Cowork',          tell: 'go through these files and produce that', build: 'Cowork task: works across folders and apps on their machine.' },
    { key: 'Skill',           tell: 'a repeatable procedure with rules a new starter could follow', build: 'Skill: the SOP written as instructions Claude loads on demand.' },
    { key: 'Connector setup', tell: 'Claude cannot see it yet', build: 'Setup: connect NetSuite, SharePoint, Outlook or Teams first.' }
  ];

  var buildTypes = ['Skill', 'Scheduled task', 'Setup', 'Project', 'Workflow redesign'];
  var functionsTags = ['Finance', 'Purchasing', 'Both', 'Org-wide'];
  var statuses = ['Open', 'Validated', 'Emerging', 'Parked', 'Merged'];

  /* Systems: assumed until confirmed. Connector notes are what Claude can
     reach today so the room can see the seams immediately. */
  var systems = [
    { id: 's1', name: 'Claude',      category: 'AI platform',     usedBy: 'Everyone', connector: 'Native',                       status: 'confirmed', note: 'Team or Enterprise plan. Chat, Projects, Scheduled Tasks, Cowork, Skills.' },
    { id: 's2', name: 'NetSuite',    category: 'ERP / finance',   usedBy: 'Finance, Purchasing', connector: 'Via MCP or CSV export', status: 'assumed', note: 'GL, AP, AR, PO, inventory. Confirm which modules and who has saved searches.' },
    { id: 's3', name: 'SharePoint',  category: 'Documents',       usedBy: 'Everyone', connector: 'Microsoft 365 connector',    status: 'assumed', note: 'Policies, month-end packs, supplier contracts. Confirm folder hygiene.' },
    { id: 's4', name: 'Outlook',     category: 'Email',           usedBy: 'Everyone', connector: 'Microsoft 365 connector',    status: 'assumed', note: 'Shared mailboxes for AP and supplier queries are the usual gold.' },
    { id: 's5', name: 'Teams',       category: 'Chat / meetings', usedBy: 'Everyone', connector: 'Microsoft 365 connector',    status: 'assumed', note: 'Where the brand and buying conversations happen.' },
    { id: 's6', name: 'Excel',       category: 'Analysis',        usedBy: 'Finance, Purchasing', connector: 'File upload / Cowork', status: 'assumed', note: 'The real system of record for allocation, pricing and forecasting.' },
    { id: 's7', name: 'Power BI',    category: 'Reporting',       usedBy: 'Finance', connector: 'Export only',                status: 'unknown',  note: 'Confirm whether dashboards exist or whether reporting is Excel.' },
    { id: 's8', name: 'Brand portals', category: 'Supplier',      usedBy: 'Purchasing', connector: 'None',                     status: 'unknown',  note: 'Rolex, Omega, TAG and others each have their own ordering and allocation portal.' },
    { id: 's9', name: 'Expense tool', category: 'Finance ops',    usedBy: 'Everyone', connector: 'Unknown',                    status: 'unknown',  note: 'Concur, Expensify or NetSuite expenses. Ask.' }
  ];

  /* Process phases: the coordinate system every opportunity gets located on.
     Cross-cutting rows catch the foundations problems. */
  var phases = [
    { id: 'F1', fn: 'Finance',    name: 'Accounts payable',            what: 'Supplier invoices in, matched to PO and receipt, approved, paid.', prompts: ['How does an invoice arrive and where does it wait?', 'What breaks a three-way match most often?', 'Who chases the approver?'] },
    { id: 'F2', fn: 'Finance',    name: 'Store cash and card reconciliation', what: 'Daily takings, card settlements, deposits, variances by store.', prompts: ['How many stores, how many days, how many exceptions a week?', 'What does a variance investigation actually involve?'] },
    { id: 'F3', fn: 'Finance',    name: 'Month-end close',             what: 'Journals, accruals, reconciliations, review, sign-off.', prompts: ['Walk me through day one to day five.', 'Which reconciliations are copy-paste from last month?', 'What is the last thing to land and why?'] },
    { id: 'F4', fn: 'Finance',    name: 'Management reporting and commentary', what: 'Monthly pack, variance commentary, board and group submissions.', prompts: ['Who writes the words? How long does the commentary take?', 'What questions come back from the board every month?'] },
    { id: 'F5', fn: 'Finance',    name: 'Budgeting and forecasting',   what: 'Annual budget, rolling reforecast, store and category views.', prompts: ['How many versions of the file exist?', 'What assumptions get re-keyed each cycle?'] },
    { id: 'F6', fn: 'Finance',    name: 'Treasury, FX and payments',   what: 'CHF and USD exposure on brand purchases, payment runs, cash forecasting.', prompts: ['Who watches the CHF rate and how do they act on it?', 'How is a payment run built and checked?'] },
    { id: 'F7', fn: 'Finance',    name: 'Audit, tax and compliance',   what: 'Year-end audit requests, VAT, statutory accounts, internal controls.', prompts: ['What did the auditors ask for last time and where did it live?', 'What evidence is assembled by hand?'] },
    { id: 'P1', fn: 'Purchasing', name: 'Demand planning and allocation', what: 'Forecast by brand, model and store; allocation requests to brand partners.', prompts: ['How do you decide what to ask a brand for?', 'What sell-through story do you tell them?'] },
    { id: 'P2', fn: 'Purchasing', name: 'Purchase orders',             what: 'PO creation, confirmation, amendment, expediting.', prompts: ['How does a PO get raised and who checks it?', 'What gets amended and why?'] },
    { id: 'P3', fn: 'Purchasing', name: 'Goods receipt and serialised stock', what: 'Receiving, serial numbers, stock transfers between stores, discrepancies.', prompts: ['What goes wrong at receipt?', 'How do transfers between stores get requested and tracked?'] },
    { id: 'P4', fn: 'Purchasing', name: 'Pricing and cost changes',    what: 'Brand price lists, cost updates, margin impact, system updates.', prompts: ['When a brand changes prices, what happens in the next 48 hours?', 'Who works out the margin impact?'] },
    { id: 'P5', fn: 'Purchasing', name: 'Supplier and brand relationships', what: 'Brand meetings, terms, performance reviews, co-op marketing claims.', prompts: ['What do you prepare before a brand meeting?', 'What do you owe them after it?'] },
    { id: 'P6', fn: 'Purchasing', name: 'Returns, service parts and warranty', what: 'Returns to brand, service centre parts ordering, warranty claims.', prompts: ['How is a return authorised and tracked?', 'How do service parts get ordered and charged?'] },
    { id: 'P7', fn: 'Purchasing', name: 'Non-merchandise procurement', what: 'Store fit-outs, services, contracts, supplier onboarding.', prompts: ['How does a new supplier get set up?', 'What does a contract renewal look like?'] },
    { id: 'X1', fn: 'Both',       name: 'Data foundations',            what: 'Exports, master data, spreadsheets that are really databases.', prompts: ['Where does the same number live twice?', 'Which file would hurt most if it vanished?'] },
    { id: 'X2', fn: 'Org-wide',   name: 'Policy, onboarding and knowledge', what: 'Answering colleagues, training new starters, finding the current version.', prompts: ['What questions do you answer every week that are already written down somewhere?'] }
  ];

  /* The 90-minute run sheet. Each block has the facilitator script and the
     questions. `capture` says which view to have on screen. */
  var agenda = [
    { id: 'a1', mins: 5,  title: 'Frame the session', view: 'runsheet',
      say: 'We are here to find where Claude gives you hours back. Not to replace anyone. Every idea you raise lands on that board and you will see the count grow. At the end I will show you a second list: things we saw that you did not raise.',
      ask: ['Confirm the north star: hours returned at constant headcount. Does that sit right?', 'One rule for scope: if Claude cannot carry the core of it, it is parked, not dropped.'] },
    { id: 'a2', mins: 10, title: 'Map the systems', view: 'systems',
      say: 'Before we talk about work, tell me what you touch. I have guessed. Correct me.',
      ask: ['Which of these do you open every day?', 'Which two do you copy between most?', 'What is missing from this list?', 'Which system do you trust least?'] },
    { id: 'a3', mins: 15, title: 'Walk the Finance process', view: 'process',
      say: 'Finance first. Phase by phase. I want how it actually happens, not the policy.',
      ask: ['What happens, who owns it, how often, how long, what tool?', 'Where does the same thing get typed twice?', 'What is the drop-everything task?', 'What do you produce every month that looks the same each time?'] },
    { id: 'a4', mins: 15, title: 'Walk the Purchasing process', view: 'process',
      say: 'Now Purchasing. Same questions. Finance, listen for where their pain is your pain.',
      ask: ['What arrives in your inbox that you wish was already summarised?', 'What would you hand to a competent new starter with a written procedure?', 'What decision waits on someone pulling numbers?'] },
    { id: 'a5', mins: 5,  title: 'Pause and catch up', view: 'opportunities',
      say: 'Stretch. While you do, the board catches up. I will tidy titles and tag functions.',
      ask: ['Facilitator: merge duplicates, fix function tags, park anything out of scope with a reason.'] },
    { id: 'a6', mins: 20, title: 'Validate, cluster, vote', view: 'opportunities',
      say: 'Here is everything we heard. For each one: is the pain real, is the direction right. Then three dots each.',
      ask: ['Is this Finance, Purchasing, both, or the whole business?', 'Who feels this most?', 'Which one would you hand over tomorrow if you trusted it?', 'Watch for convergence: three people raising the same thing unprompted.'] },
    { id: 'a7', mins: 10, title: 'The second viewpoint', view: 'second',
      say: 'These are the things we saw from outside. For each one I will tell you why I think it did not come up.',
      ask: ['Which of these is obviously right?', 'Which one makes you uncomfortable, and why?', 'Which is already being done somewhere you know of?'] },
    { id: 'a8', mins: 10, title: 'Commit and export', view: 'opportunities',
      say: 'Top five by votes. An owner for each. The first build starts this week.',
      ask: ['Who owns each of the top five?', 'What is the first skill we write together?', 'Export the register and send it to the room today.'] }
  ];

  /* Question bank: pulled from the engagement field guide plus the AI-specific
     tells that map a pain to a Claude surface. */
  var questionBank = [
    { group: 'Process and volume', qs: ['Walk me through what happens from the moment [trigger] to [output]. Who touches it, in what order?', 'How many of these do you do a week? A year?', 'How long does [step] take today?', 'Where does the same information get typed into more than one system?', 'Which part of this is the drop-everything task?'] },
    { group: 'Pain and risk', qs: ['What is the most annoying, most manual part of your week?', 'When [artefact] comes back wrong, what does that look like, and how do you catch it?', 'What breaks when the person who normally does this is away?', 'Where are you most exposed if nothing changes?'] },
    { group: 'Tools and data', qs: ['What systems does this touch? Which ones talk to each other?', 'Where do these files live? Could someone who is not you find the latest version?', 'Is there anything you would not put through Claude? Customer names, serials, salaries?'] },
    { group: 'Surface tells (listen for these)', qs: ['"Every Monday / every month-end" = Scheduled Task', '"I always paste in the same policy / template" = Project', '"There is a procedure, it just lives in my head" = Skill', '"Go through the folder and produce the pack" = Cowork', '"Claude cannot see that system" = Connector setup'] },
    { group: 'Scar tissue and adoption', qs: ['What have you tried before that did not stick? What made it fail?', 'What would a tool have to do before you stopped double-checking it?', 'If you could hand one task over completely tomorrow, what would it be?'] }
  ];

  /* Consultant blind-spot ideas. The mandatory column is `why`: why the room
     did not raise it. If that column is empty the idea is not a blind spot. */
  var blindSpots = [
    { id: 'N1', title: 'Draft the month-end variance commentary from the trial balance', fn: 'Finance', phase: 'Management reporting and commentary', surface: 'Claude Project', build: 'Project',
      what: 'A Project loaded with last three months of commentary, the chart of accounts and the house style. Drop in the TB export and it drafts the variance notes in your voice, flagging anything over threshold.',
      why: 'The team sees commentary as judgement, not drafting. They do not notice that eighty percent of the words are the same every month.', lift: 'Two to four hours per person per close.', comparator: 'Standard practice in listed-company finance teams using Claude Projects.', confidence: 'High' },
    { id: 'N2', title: 'Invoice exception triage that explains the mismatch and drafts the supplier email', fn: 'Both', phase: 'Accounts payable', surface: 'Skill', build: 'Skill',
      what: 'A Skill that reads the invoice PDF and the PO, names the mismatch in plain English (quantity, price, missing receipt), and drafts the query to the supplier or the buyer.',
      why: 'AP and Purchasing each see their half of the exception. Neither sees that the hand-off between them is the slow part.', lift: 'Twenty to forty minutes per exception; exceptions run daily.', comparator: 'AP exception bots in retail shared services.', confidence: 'High' },
    { id: 'N3', title: 'Brand price-change impact in an hour, not a week', fn: 'Purchasing', phase: 'Pricing and cost changes', surface: 'Cowork', build: 'Workflow redesign',
      what: 'When a brand issues a new price list, Cowork reads it against the current cost and retail file, produces margin impact by model and store, and lists the system updates needed.',
      why: 'It is done in Excel by one experienced person, so nobody sees it as a process. It is a process.', lift: 'A day per price change, several changes a year per brand.', comparator: 'Merchandise planning teams at multi-brand retailers.', confidence: 'Medium' },
    { id: 'N4', title: 'The allocation case: a sell-through story for every brand meeting', fn: 'Purchasing', phase: 'Demand planning and allocation', surface: 'Scheduled Task', build: 'Scheduled task',
      what: 'A weekly task that builds the sell-through narrative per brand from sales and stock exports: what sold, where, how fast, and what we are asking for and why.',
      why: 'Allocation is seen as a relationship, not a document. The document is what wins the relationship.', lift: 'Half a day before every brand meeting.', comparator: 'Wholesale account teams preparing sell-in decks.', confidence: 'Medium' },
    { id: 'N5', title: 'Shared AP mailbox triage every morning', fn: 'Finance', phase: 'Accounts payable', surface: 'Scheduled Task', build: 'Scheduled task',
      what: 'Each morning, classify overnight mail in the AP mailbox: invoice, statement, query, remittance, spam. Extract the key fields and route or draft the reply.',
      why: 'A shared mailbox is assumed to be a human queue. Nobody has asked what a triage step in front of it would remove.', lift: 'One to two hours a day across the team.', comparator: 'Outlook plus Claude scheduled tasks in finance shared services.', confidence: 'High' },
    { id: 'N6', title: 'Audit evidence pack assembled from the request list', fn: 'Finance', phase: 'Audit, tax and compliance', surface: 'Cowork', build: 'Workflow redesign',
      what: 'Give Cowork the auditor request list and SharePoint access. It finds, names and indexes the evidence, and lists what it could not find.',
      why: 'Seasonal pain is forgotten between seasons. By the time it hurts there is no time to fix it.', lift: 'Days per audit cycle.', comparator: 'Big-four client portals now expect this shape of pack.', confidence: 'Medium' },
    { id: 'N7', title: 'A policy and procedure Project that answers colleagues with citations', fn: 'Org-wide', phase: 'Policy, onboarding and knowledge', surface: 'Claude Project', build: 'Project',
      what: 'Expense policy, procurement thresholds, delegation of authority, supplier onboarding steps. One Project, cited answers, shared with the business.',
      why: 'Answering colleagues does not feel like work, so it is never counted. It is hours a week.', lift: 'Two to five hours a week across the two teams.', comparator: 'Internal knowledge assistants on Claude Enterprise.', confidence: 'High' },
    { id: 'N8', title: 'Brand meeting notes into PO amendments and follow-ups', fn: 'Purchasing', phase: 'Supplier and brand relationships', surface: 'Skill', build: 'Skill',
      what: 'After a brand meeting, the notes go in and out come the PO changes, the follow-up emails and the calendar holds, each one checked before sending.',
      why: 'The meeting is the visible work. The admin after it is invisible and it leaks.', lift: 'An hour per brand meeting.', comparator: 'Sales ops meeting-to-CRM flows.', confidence: 'Medium' },
    { id: 'N9', title: 'Weekly CHF exposure brief against open orders', fn: 'Both', phase: 'Treasury, FX and payments', surface: 'Scheduled Task', build: 'Scheduled task',
      what: 'Every Monday: rate movement, open PO value by currency, cost impact if it holds, and the three questions Finance should ask Purchasing this week.',
      why: 'Treasury is "someone else". Neither team owns the conversation between them.', lift: 'Better decisions, not hours. Sized in margin.', comparator: 'Importer treasury briefs.', confidence: 'Low' },
    { id: 'N10', title: 'Slow-mover and ageing stock narrative for buyers', fn: 'Purchasing', phase: 'Goods receipt and serialised stock', surface: 'Scheduled Task', build: 'Scheduled task',
      what: 'Weekly: what has not moved in 90, 180, 365 days by brand and store, what it is costing, and three suggested actions per line.',
      why: 'The report exists. The narrative and the suggested action do not, so the report is not read.', lift: 'Working capital, plus an hour a week of analysis.', comparator: 'Merch planning exception reporting.', confidence: 'Medium' },
    { id: 'N11', title: 'New starter onboarding for Finance and Purchasing', fn: 'Org-wide', phase: 'Policy, onboarding and knowledge', surface: 'Claude Project', build: 'Project',
      what: 'The how-we-do-things Project: systems, month-end calendar, who to ask, the ten most common tasks as Skills. A new starter is useful in week one.',
      why: 'Nobody in the room is new. The cost of onboarding is paid by whoever left last.', lift: 'Weeks of ramp time per hire.', comparator: 'Onboarding Projects on Claude Team plans.', confidence: 'High' },
    { id: 'N12', title: 'Board pack consistency check before it leaves the building', fn: 'Finance', phase: 'Management reporting and commentary', surface: 'Skill', build: 'Skill',
      what: 'A Skill that reads the finished pack and checks: numbers match between pages, commentary matches the numbers, terminology is consistent, nothing from last month was left in.',
      why: 'Checking is done by the same tired eyes that wrote it. It is not seen as a task that could be handed over.', lift: 'Fewer restatements. Sized in credibility.', comparator: 'Financial reporting QA skills.', confidence: 'High' }
  ];

  /* A demo transcript: eight voices, roughly the order the workshop runs.
     Each chunk is what a transcript source would deliver in one poll. */
  var demoTranscript = [
    'Facilitator: Let us start with systems. NetSuite for everything finance and purchase orders, SharePoint for documents, Outlook and Teams. Anything missing?',
    'Priya (AP lead): The AP mailbox. Two hundred emails a day, invoices, statements, people asking where their payment is. I go through it every morning before I do anything else. Takes an hour, sometimes more.',
    'Dan (Financial controller): And Excel. Honestly the allocation file and the reforecast are Excel. NetSuite is where it ends up, not where the thinking happens.',
    'Sam (Head of buying): Each brand has its own portal as well. Rolex is one thing, Omega another. We re-key the confirmed orders into NetSuite by hand because nothing talks to anything.',
    'Facilitator: Good. Finance process. Priya, take me through an invoice arriving.',
    'Priya (AP lead): It arrives as a PDF. I check there is a PO. If the quantity or price does not match I email the buyer, wait, they email the brand, wait. About a third of invoices have some mismatch. I would say twenty minutes each just to work out what is wrong and write the email.',
    'Ana (Management accountant): Month-end is day one to day five. Half my reconciliations are the same as last month with different numbers. I copy the previous month file, update it, and rewrite the notes. The commentary takes me a full day and Dan rewrites half of it.',
    'Dan (Financial controller): I rewrite it because the board asks the same four questions every month and the commentary never pre-empts them. Store performance, gross margin by brand, stock days, and cash.',
    'Leah (FP&A analyst): The reforecast has eleven versions on SharePoint right now. I do not know which one is current and neither does anyone else. I spend the first day of every cycle finding out.',
    'Facilitator: What about the stores? Cash and card?',
    'Ana (Management accountant): Forty stores, daily. Card settlements do not match the till on maybe ten percent of days and each one is an email to the store manager. I would hand that over tomorrow if I trusted it.',
    'Facilitator: Purchasing. Sam, allocation.',
    'Sam (Head of buying): Allocation is the whole game. Every brand meeting I need the sell-through story. What sold, where, how fast, why we deserve more. I build it in Excel the night before, every time. Two or three hours.',
    'Marcus (Merchandiser): And when a brand changes prices, which is twice a year for the big ones, I spend a week working out margin impact by model and store and then updating NetSuite line by line. It is the same spreadsheet every time.',
    'Jo (Supply chain coordinator): Receiving is fine until a serial number does not match the PO. Then it is emails between the store, me and the brand for days. Store transfers are the same, it is all email and a spreadsheet I keep.',
    'Tom (Procurement manager): On my side the pain is contracts and supplier onboarding for fit-outs. New supplier means a form, a credit check, a NetSuite record, and I chase each step. And people ask me what the approval threshold is every week even though it is on SharePoint.',
    'Facilitator: What have you tried before that did not stick?',
    'Dan (Financial controller): A workflow tool for invoice approvals. Nobody looked at it because it lived outside Outlook. If it is not in the inbox it does not exist.',
    'Priya (AP lead): I would not put customer names through anything. Serial numbers I am nervous about too. Supplier invoices I do not mind.',
    'Sam (Head of buying): After a brand meeting I have a page of notes and then a week of chasing the changes. If something could turn the notes into the PO amendments and the emails, that is my week back.',
    'Leah (FP&A analyst): Nobody watches the Swiss franc. We find out at month-end what it did to cost of sales. By then the orders are placed.'
  ];

  return {
    client: client, surfaces: surfaces, buildTypes: buildTypes, functionsTags: functionsTags,
    statuses: statuses, systems: systems, phases: phases, agenda: agenda,
    questionBank: questionBank, blindSpots: blindSpots, demoTranscript: demoTranscript
  };
})();
