# Handover: Ideation Board

*Updated 18 September 2026, after the session that added the QR join, fixed the AI read path and the second viewpoint, and moved production to `main`.*

Read this first in a new session. It says what exists, where it runs, what is proven, what is not, the decisions already made, and the exact next steps. A copy with a paste-in prompt for the next conversation lives in Max's vault at `_meta/session-handover-wos-ideation-board-2026-09-18.md`.

## What this is

A facilitation board for a 90-minute AI opportunity workshop. First client: Watches of Switzerland, Finance and Purchasing, eight people. The facilitator (Max) drives it from a laptop on the projector. Participants scan a QR code on the screen, type their name, and are in: they add ideas and dot-vote from their phones. Claude reads the pasted transcript and drops tagged opportunities onto the board. At the end a sealed "second viewpoint" reveals prepared blind-spot ideas plus ones Claude writes from the transcript. Everything exports to Excel.

Built for reuse: every workshop stores its own template (client name, teams, phases, run sheet, blind spots), so the next client is a form, not a rebuild.

## Where everything is

| Thing | Location |
|---|---|
| Code | GitHub `WeAreGoodVibe/Ideation-workshop`, branch `main`. Work happens on a `claude/...` branch and is fast-forwarded into `main`. |
| Live site | https://ideation-workshop-three.vercel.app. Vercel project `ideation-workshop`, team `max-einsohns-projects` (`team_KT1cyRFvBPNcFchM42NKekDe`). **Production tracks `main`** (Environments → Production → Branch Tracking, changed 18 Sep). Other branches build previews only. |
| Database and login | Supabase project `iaqtvtqsputfnityhfog` (name Ideation-Workshop, Singapore region) |
| claude.ai Artifact version | https://claude.ai/artifact/3jjeNVkZcnzL2CpH18xzTi. Older build, no login, uses Artifact capabilities. Not updated since the backend work. Fallback only. |
| Docs | `README.md`, `docs/DEPLOY.md` (setup, Supabase toggles, Resend SMTP steps), `docs/WISPR-BRIDGE.md`, `docs/WORKSHOP-PLAN.md`, this file |

Connectors that make a Claude session useful here: **Supabase** (SQL, logs, migrations; used throughout), **Vercel** (deployments, runtime logs, fetching the live site; works for this team now), **GitHub**, **Dropbox** (the vault).

## Architecture in one breath

Static page (`index.html`, `app.js`, `sb.js`, `help.js`, `styles.css`, `data/seed.js`, `engine/` from scroll-craft, `vendor/qrcode.js`) plus three Vercel functions in `api/`: `config` (hands the browser the public Supabase URL and anon key, and whether the server has a Claude key), `extract` (runs Claude with the server key, facilitators only), `ingest` (a token-protected door for a Claude session to post transcript and ideas). Supabase holds the data with row level security; schema in `supabase/schema.sql`, applied to the live project as migrations `ideation_board_init`, `harden_functions`, `org_creator_can_read_own_org`, `opportunity_seq_lock`.

Roles: the person who creates an organisation is its facilitator. Anyone who joins with the code is a participant. Promote someone with `update org_members set role = 'facilitator' where email = '...'`.

Sign-in: facilitators use an emailed magic link. Participants sign in anonymously (Supabase "Allow anonymous sign-ins", on) when they scan the QR; the join code rides inside the QR link. A phone that will not scan opens the link and types name and code.

## Current state (18 Sep 2026)

| Item | State |
|---|---|
| Live site | Serves `main`. Sidebar reads "AI ready". |
| Users | `max.einsohn@acquire.ai` facilitator of org "Watches of Switzerland" (workshop "Finance and Purchasing Ideation Workshop", code 2469, clean). `acquire@watchswiss.com` facilitator of org "Watches of Switzerland Test" (workshop code 3499, used for testing, has transcript and ideas). One anonymous participant user from the phone test. |
| Proven on the live site today | Magic-link sign-in. Org and workshop creation. QR scan → name → in, on a real phone. Transcript paste → Read now → ideas on the board. Dot voting. Second viewpoint reveal. |
| Not yet proven | Two phones voting at once with totals moving live on the laptop. Excel export from the live site. Re-seal. The Wispr bridge route (`/api/ingest`). |
| Known wrong | `SUPABASE_SERVICE_ROLE_KEY` on Vercel is invalid (returns `supabase 401: Invalid API key`). Only `/api/ingest` uses it now, so the day does not depend on it. Re-copy from Supabase → Project Settings → API keys, paste into Vercel, redeploy. |
| Email | Supabase's own mailer, 2 emails an hour. Only facilitators need email now. Resend steps in `docs/DEPLOY.md` section 1, not done. |

## What changed this session, and why

**QR join with anonymous sign-in.** The email round trip was the biggest risk on the day: a 2-an-hour mailer, corporate spam filters, eight people waiting. Participants do not need an identity that survives devices, so an anonymous Supabase session with a display name is enough. Voter names still show on tallies. Cost: one person can scan on two devices and get six dots; visible in the names, acceptable for eight people.

**AI read no longer touches the service key.** `/api/extract` checked "is this a facilitator" with the service-role key; the key on Vercel was wrong, so every read failed before Claude was called. The check now runs `my_role()` as the caller with their own JWT, the same call the sidebar uses. Fewer secrets in the critical path.

**Read loop backs off.** A failed read retried every 1.5 seconds while the backlog was large: 116 failed calls in two minutes. Now 10s, 20s, 40s, up to two minutes, with the failure count in the sidebar and a toast on the first failure.

**Idea numbering is serialised.** The trigger that numbers ideas read `max(seq) + 1` with no lock; a burst of inserts from one read collided on the unique key. It now takes a per-workshop advisory lock (`pg_advisory_xact_lock`), and the client retries a collision. Verified with a three-row burst.

**Second viewpoint survives data refreshes.** Every realtime refresh rebuilt the view's DOM while the scroll engine drove the old nodes, so scrolling back up showed blank copy. The revealed view now re-renders only when its content signature changes, and the engine gained `destroy()` so a remount does not leave a dead instance ticking. Opening the view lands on the pinned stage (so a phone does not see empty canvas), the opening screen is lit at rest with the real count, and a "Scroll down" pill sits at the bottom until the reader moves.

**Production moved to `main`.** Two branches both claiming to be production caused the "AI off" confusion (a preview domain without the key). One production branch ends that.

## Changed on 18 September, afternoon session (blank slate, join link, live systems and phases)

**Every new workshop is a blank slate.** Creating a workshop no longer deep-copies `data/seed.js`. The config it stores has the client's own words (name, teams, an optional one-line "about" for Claude, north star, scope test), generic vocabulary (surfaces, build types, statuses, question bank), a run sheet generated with one process walk block per team, and empty `systems`, `phases`, `blindSpots` and `demoTranscript`. The database trigger seeds nothing from empty arrays. On load the page merges `SEED`, then a blank baseline, then the workshop config, so a backend workshop can never inherit WoS content by omission. The three workshops that existed before this change (codes 2469, 3499, 1775) still carry the WoS template; **Settings → This workshop → Start blank** wipes their systems, phases and prepared ideas and keeps opportunities, votes, transcript and Claude's own second viewpoint ideas.

**The join link is generated with the QR.** `?w=<slug>&code=<code>` is now shown as text on the join card, on the big QR screen, in Settings → This workshop, and per row in the Workshops list, each with Copy. It is the QR as text: open it, type a name, in.

**Claude populates systems and phases live.** Each read of the transcript returns opportunities, plus systems the room named and process stages it described, both deduplicated by name against what the board already has. Systems land as "assumed"; phases land in the workshop config, so the Process walk grows as the room talks. The server schema (`api/extract.js`) takes the workshop's team tags from the request body instead of a hard-coded Finance/Purchasing list, so other clients' team names work.

**Phases are editable in the board.** Process walk → Add a phase, Edit phase, delete. Renaming a phase moves its ideas. Ideas whose phase matches no card show under "Not yet placed on a phase" with a one-press "Make this a phase". The opportunity sheet takes free-text phases until phases exist.

**Second viewpoint for a blank workshop** is Claude's list only, written from this workshop's transcript and board; the prompt says so explicitly. Copy on the sealed screen and the header changed to match.

Verified with Playwright against a stubbed backend and a stubbed Claude reply (scripts in the session scratchpad, not the repo): creation config, run sheet blocks, join link text, empty states, a read adding one system and one phase and deduplicating existing ones, Start blank. Not yet run against the live Supabase project: create a fresh workshop on the live site and confirm the Systems and Process walk views are empty.

## Changed on 18 September, third session (participants can add, names always, any number of votes)

**Phases are rows now.** New table `phases` (migration `participant_content`), one row per phase with `source` (Facilitator, Participant, AI), `added_by` and `created_by`. The same three columns were added to `systems`. A before-insert trigger stamps `created_by` from the caller. The phases that older workshops kept in `config.phases` were moved into rows and the key removed from config. Realtime carries `phases`; `systems` and `phases` have replica identity full so deletes reach every screen.

**Participants add, edit and delete their own.** Policies: facilitators do anything; members insert with `source = 'Participant'` and update or delete rows where `created_by = auth.uid()` and source is Participant. Same for opportunities (a delete policy was added). In the page, `canEdit(row)` decides which cards show "Edit or delete". Claude's rows are tagged "Heard by Claude"; everything else shows "Added by <name>".

**Nobody gets in without a name.** `enterWorkshop` checks the member's `display_name`; if it is empty, a "What is your name?" screen blocks entry (phone or laptop, new or old session). The join form also always requires a name. `SB.setName` writes `org_members.display_name` and the user metadata.

**Votes per person is any number.** The creation form has no maximum, Settings → This workshop has an editable "Votes per person" with Save, and the `votes.dots` check no longer caps at 20. All wording says votes, with "one dot is one vote" in the tips.

**Business name and teams come from the workshop.** `#brandClient` and the new `#brandSub` are set from the workshop config; index.html no longer names Watches of Switzerland. Export file names use the client name.

Verified with Playwright against the fake backend: facilitator creates a workshop, a read adds an AI phase and system, a hand-added phase carries the facilitator's name, votes per person saves; a participant opening the join link is asked for a name, then adds a system and a phase with their name on them, sees Edit or delete only on their own rows, and adds, edits and deletes their own idea. Not yet exercised on the live project: a participant phone against the real policies.

## Changed on 20 September (reset votes, prompts and skills)

On a branch, not yet merged. Two things the facilitator asked for after running a live session.

**Reset votes.** A Voting bar now sits at the top of the Opportunities view, above the filters. It shows how many votes have been cast, lets the facilitator change **Votes each** without leaving the board, and has **Reset votes**, which clears every vote so the room can go again on a shorter list. It survives presentation mode (`part-hide`, not `fac`), because that is exactly when it is needed, and participants never see it.

Reset needs a database function. Row level security lets a person delete only their own vote rows, so a facilitator clearing the room's votes is impossible from the browser. `public.reset_votes(p_ws, p_opp)` is security definer and does the facilitator check itself. It is in `schema.sql` for a fresh project and in `supabase/migration-002-reset-votes.sql` for one that already exists. Until that runs, the button says what to run and does nothing.

**Prompts and skills.** A new view, key 6, between Second viewpoint and Live capture. **Generate** sends the ideas the room landed on (never Parked or Merged, Validated first, then best voted) to Claude, two per request with three requests in flight, and gets back a pack for each: an **interview prompt** that makes Claude interview whoever owns that work, the **artefact** itself shaped by build type (a SKILL.md, a scheduled task prompt, project instructions, a setup checklist, a redesigned workflow), a **first message** to send once it exists, the connectors it needs and one watch-out. Every part has a Copy button. The packs also come out as a **Prompts and Skills** tab in the Excel export.

The packs live in `workshops.config.promptPacks`, keyed by opportunity id, so no schema change was needed for this half and every screen gets them over realtime. In standalone mode they live in `S.promptPacks` in localStorage.

Two requests at a time keeps each reply inside the token ceiling and the function timeout; `vercel.json` now sets `maxDuration` 60 on `api/*.js` so a slow generation is not cut off.

## Dead ends, so the next session does not repeat them

- "AI off" in the sidebar with the key present on Vercel was a stale tab or a preview domain, not a code problem. Check the URL and hard reload before touching anything.
- Vercel's production branch setting is no longer on the Git settings page. It is under Environments → Production → Branch Tracking.
- The Supabase MCP cannot toggle auth settings (anonymous sign-ins, SMTP). Those are dashboard clicks for Max.
- The remote session's proxy blocks `vercel.app`, `supabase.co` and `jsdelivr.net` from curl. Use the Vercel connector's `web_fetch_vercel_url` to read the live site, and `npm pack` to fetch libraries.
- Playwright tests of server mode need `window.supabase` stubbed; the CDN is blocked. Scripts live in the session scratchpad, not the repo.
- The mic and a Wispr paste at the same time double the transcript. Dedupe keeps the board clean but each read costs twice. Use one source; the paste is more accurate.

## Test with a colleague (next thing to do)

1. Laptop: sign in as `max.einsohn@acquire.ai`, open the real workshop (code 2469) or the Test one (3499). Sidebar "AI ready". Run sheet → Show big.
2. Colleague's phone, mobile data: scan, type name, Join. Expect the Opportunities view with three dots. If they see an email form, anonymous sign-ins have been switched off in Supabase.
3. Your phone too, so there are two voters.
4. Laptop: Live capture, paste three paragraphs, Read now. Ideas should land on both phones within a minute with no refresh.
5. Both phones vote. Laptop totals move; hover shows the names.
6. Colleague adds an idea from the phone. It lands with their name.
7. Laptop: Second viewpoint → Reveal (say the framing sentence while Claude writes, 30 to 60 seconds) → scroll down and back up → Re-seal.
8. Export Excel. Open the file.
9. Afterwards delete the Test workshop's rows in the table editor if you used it, or leave the real one clean by testing on Test only.

To make the colleague a facilitator instead: they sign in by email on the bare site URL, then run the promote SQL above with their address.

## Next steps, in order

1. Colleague test above.
2. Fix `SUPABASE_SERVICE_ROLE_KEY` on Vercel and redeploy (only matters for the Wispr bridge): Supabase → Project Settings → API Keys → Secret keys → Create new secret key → paste over the Vercel variable (all environments) → Redeploy. Exact steps in `docs/DEPLOY.md` section 2.
2a. Create a fresh workshop on the live site and confirm it opens empty (no systems, no phases, second viewpoint sealed with the Claude-only copy). Press Start blank on the three older workshops if they are to be reused for other clients.
3. Resend SMTP (`docs/DEPLOY.md` section 1), so facilitator sign-in on a new device is not capped at two an hour.
4. Delete the `claude/trusting-feynman-qr5izj` branch on GitHub; it is history.
5. Optional hardening before a larger room: a database rule limiting one anonymous membership per name per workshop, or a facilitator control to remove a participant.
6. Optional: republish the claude.ai Artifact build only if it is wanted as a fallback.

## Environment variables on Vercel

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (legacy JWT or `sb_secret_...`, currently wrong), `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` (default `claude-opus-5`). Functions only see them after a deployment.

## Supabase auth settings expected

Site URL `https://ideation-workshop-three.vercel.app`. Redirect URLs `https://ideation-workshop-three.vercel.app/**` and `https://ideation-workshop-max-einsohns-projects.vercel.app/**`. Email provider on, confirm email off. Anonymous sign-ins on. Anonymous rate limit 30 an hour per IP by default; raise it for a room over about twenty on one Wi-Fi.

## How the workshop runs (short)

Blocks: frame 5, systems 10, Finance walk 15, Purchasing walk 15, pause 5, validate and vote 20, second viewpoint 10, commit and export 10. Full script and questions in `docs/WORKSHOP-PLAN.md` and inside the board's Run sheet. Press P for presentation mode on the projector. Paste the transcript every four or five minutes; the box keeps only the new part. Export Excel at block 5 as insurance and again at block 8.
