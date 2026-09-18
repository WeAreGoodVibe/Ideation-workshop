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
| Live site | Serves `main` at commit `c035162` or later. Sidebar reads "AI ready". |
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
2. Fix `SUPABASE_SERVICE_ROLE_KEY` on Vercel and redeploy (only matters for the Wispr bridge).
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
