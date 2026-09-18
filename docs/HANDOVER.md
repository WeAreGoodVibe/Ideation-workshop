# Handover: Ideation Board

Read this first in a new session. It says what exists, where it runs, what is proven, what is not, and the exact next steps.

## What this is

A facilitation board for a 90-minute AI opportunity workshop. First client: Watches of Switzerland, Finance and Purchasing, eight people. The facilitator (Max) drives it from a laptop on the projector. Participants open it on their phones, sign in by emailed link, add ideas and dot-vote. Claude reads the pasted transcript and drops tagged opportunities onto the board. At the end a sealed "second viewpoint" reveals prepared blind-spot ideas plus ones Claude writes from the transcript. Everything exports to Excel.

Built for reuse: every workshop stores its own template (client name, teams, phases, run sheet, blind spots), so the next client is a form, not a rebuild.

## Where everything is

| Thing | Location |
|---|---|
| Code | GitHub `WeAreGoodVibe/Ideation-workshop`, branches `main` and `claude/trusting-feynman-qr5izj` (identical; the Claude branch is the repo default and the one Vercel production tracks) |
| Live site | https://ideation-workshop-three.vercel.app (Vercel project `ideation-workshop`, team `max-einsohns-projects`, auto-deploys on push) |
| Database and login | Supabase project `iaqtvtqsputfnityhfog` (name Ideation-Workshop, Singapore region) |
| claude.ai Artifact version | https://claude.ai/artifact/3jjeNVkZcnzL2CpH18xzTi (older build: no login, uses Artifact capabilities instead) |
| Docs | `README.md`, `docs/DEPLOY.md`, `docs/WISPR-BRIDGE.md`, `docs/WORKSHOP-PLAN.md`, this file |

Connectors that make a Claude session useful here: **Supabase** (run SQL, read logs, apply migrations), **Vercel** (must be re-authorised for team `max-einsohns-projects`; it was not, so deployments were checked by Max, not by Claude), **GitHub**.

## Architecture in one breath

Static page (`index.html`, `app.js`, `sb.js`, `help.js`, `styles.css`, `data/seed.js`, `engine/` from scroll-craft) plus three Vercel functions in `api/`: `config` (hands the browser the public Supabase URL and anon key), `extract` (runs Claude with the server key, facilitators only), `ingest` (a token-protected door for a Claude session to post transcript and ideas). Supabase holds the data with row level security; schema in `supabase/schema.sql`, already applied to the live project as migrations `ideation_board_init`, `harden_functions`, `org_creator_can_read_own_org`.

Roles: the person who creates an organisation is its facilitator. Anyone who joins with the code is a participant. Promote someone by setting `org_members.role = 'facilitator'` in the Supabase table editor.

## Proven

- Local mode, participant flow and facilitator flow in Chromium (scripts in the session scratchpad, not in the repo).
- Database: 23-step SQL test as a fake facilitator and participant. Creator becomes facilitator, seeds land, wrong code refused, participants cannot read transcript or secrets or edit the workshop, fourth dot refused, direct 5-dot insert refused, tallies name the voter.
- Magic-link sign-in on the live site: Max's user exists in `auth.users`.
- Supabase security advisor: clean after hardening.

## Not yet proven

- Creating an organisation and workshop from the live site. It failed once with "new row violates row-level security policy for table orgs". Root cause: the insert returned the row in the same statement, before the trigger added membership. Fixed in the database (policy now also allows `created_by = auth.uid()`) and in `sb.js` (insert, then read back). **Not retested by a human yet.**
- AI on the live site. Sidebar said "AI off" because `ANTHROPIC_API_KEY` was added to Vercel after the last deployment. A redeploy happened since. Check the sidebar says "AI ready".
- Realtime updates between two devices on the live site.
- Resend SMTP for magic links (Supabase's own mailer allows 2 emails an hour). Since the QR join, only facilitators use email; participants join anonymously. Steps in `docs/DEPLOY.md` section 1.
- QR join on a real phone. The Run sheet join card carries a QR (link plus join code); scanning it shows a name prompt and signs the phone in anonymously. Needs **Allow anonymous sign-ins** on in Supabase Authentication → Providers, which is a dashboard toggle and has not been flipped yet. Tested in Chromium at 390px only.
- Wispr Flow in-progress transcript readability. Max's plan is to paste the live transcript every few minutes instead; the paste box keeps only the new part. That path needs no Wispr integration.

## Next steps, in order

1. Open https://ideation-workshop-three.vercel.app, sign in, Settings → Workshops → New workshop. Organisation "Watches of Switzerland", title, join code. Expect the join card on the Run sheet. If it fails, read the error text and check the Supabase logs (`query_logs` with source `postgres_logs`).
2. Confirm in the database: `select * from org_members; select title, join_code from workshops; select count(*) from second_ideas;` Expect one facilitator row, one workshop, twelve second ideas.
3. Supabase → Authentication → Providers → turn on anonymous sign-ins. Then scan the QR on the Run sheet with a phone, type a name, vote. Watch the total change on the laptop without a refresh.
4. Live capture → paste a few paragraphs → Read now. Expect ideas on the board within a minute. If not, Settings → AI brain tells you whether the server key is missing.
5. Second viewpoint → Reveal → scroll. Then Re-seal.
6. Set up Resend SMTP in Supabase before the day.
7. Settings → Reset is not available in server mode; to clear a test workshop delete it in the Supabase table editor (`workshops` row; everything under it cascades).

## Environment variables on Vercel

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` (default `claude-opus-5`). Functions only see them after a deployment.

## Supabase auth settings expected

Site URL `https://ideation-workshop-three.vercel.app`. Redirect URLs `https://ideation-workshop-three.vercel.app/**` and `https://ideation-workshop-max-einsohns-projects.vercel.app/**`. Email provider on, confirm email off.

## Known rough edges

- The Vercel connector in claude.ai is not authorised for the team, so Claude cannot read deployments or logs until it is reconnected with that scope.
- The claude.ai Artifact build is a different code path (no login, Artifact `sample`, `mcp`, `db`, `downloads`). It has not been republished since the backend work and does not need to be unless it is the fallback for the day.
- Facilitator "Reset the whole board" only clears this browser's local state; in server mode use the Supabase table editor.
- Mobile layout for participants is tested at 390px width in Chromium, not on a real phone.

## How the workshop runs (short)

Blocks: frame 5, systems 10, Finance walk 15, Purchasing walk 15, pause 5, validate and vote 20, second viewpoint 10, commit and export 10. Full script and questions in `docs/WORKSHOP-PLAN.md` and inside the board's Run sheet. Press P for presentation mode on the projector.
