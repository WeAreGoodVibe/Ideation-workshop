# Ideation Board

A facilitation board for a 90-minute AI opportunity workshop with the Finance and Purchasing teams at Watches of Switzerland. One static page, no build step. The room looks at it on a projector. The facilitator drives it from a laptop. Claude listens to the transcript and drops opportunities onto the board with a number.

## What it does

| View | Who sees it | What it is for |
|---|---|---|
| Run sheet | Facilitator | Eight timed blocks, the script for each, the questions to ask, a question bank. Timer and block name show in the top bar for the room. |
| Systems | Room | The tech stack, assumed until confirmed. Each system shows what Claude can reach today. |
| Process walk | Room | Finance and Purchasing phases as cards. The number on each card is how many opportunities landed there. The heat map builds itself. |
| Opportunities | Room | Every idea, tagged by function (Finance, Purchasing, Both, Org-wide), phase, Claude surface, build type, status. Cards or table. Inline editing. Votes. Excel export. |
| Second viewpoint | Room, after reveal | Sealed until block 7. Twelve consultant blind-spot ideas prepared in advance, plus what Claude writes from today's transcript. Each one says why the room did not raise it. |
| Live capture | Facilitator | Transcript sources, the AI read loop, the log. Hidden in presentation mode. |
| Settings | Facilitator | API key, model, poll rate, Wispr Flow meeting, feed URL, theme. |

Press **P** for presentation mode: facilitator-only controls disappear and type grows for the projector. Keys 1 to 7 switch views, Space starts and pauses the block timer, N moves to the next block.

## Four ways to run it

**0. Deployed with the backend (the real thing).** Vercel hosts the page and two small functions; Supabase holds organisations, workshops, members, ideas and votes with row level security and magic-link sign-in. Participants open the link on their phone, enter the join code, and vote from their seat. Every screen updates live. Setup in `docs/DEPLOY.md`.


**1. Published as a claude.ai Artifact (recommended for the live session).**
The page probes `claude.use()` for four capabilities and lights up what it finds:

- `sample`: Claude reads the transcript with no API key. The viewer's own plan pays.
- `mcp`: the page polls the Wispr Flow connector directly for the meeting transcript.
- `db`: the register is shared, so all eight people can open the link on their own device and see the same board.
- `downloads`: Excel export through the Artifact save prompt.

**2. Standalone (GitHub Pages, Vercel, or open `index.html` from disk).**
Put an Anthropic API key in Settings. The page calls the Messages API from the browser. Transcript comes from Wispr Flow dictation into the capture box, the browser mic, a paste, or a JSON feed URL. State lives in this browser's localStorage. Export to share.

**3. Demo.**
Live capture has a demo transcript: eight voices from a made-up WoS session, one line every nine seconds. Use it to test the whole loop before the room exists.

## Getting the transcript in

| Source | Works where | Notes |
|---|---|---|
| Wispr Flow dictation into the capture box | Everywhere | Press the Wispr hotkey, talk, it types. The most reliable path for a facilitator summarising as they go. |
| Browser mic | Everywhere with Chrome | Web Speech API. Free, rough, live. Needs mic permission and a quiet-ish room. |
| Wispr Flow meeting recorder via the connector | Artifact only | Polls `get_meeting` every 45 seconds with a moving `start_char`. Pick the meeting in Settings once the recording has started. **Untested against an in-progress meeting**: the connector may only return the transcript once the meeting is finalised. Test this before the day. |
| JSON feed URL | Everywhere | A Claude Code or Cowork session polls Wispr Flow, extracts opportunities, and writes `feed.json`. The page polls it. See `docs/WISPR-BRIDGE.md`. |
| Paste | Everywhere | Paste any text into the capture box. |

## Files

```
index.html          shell, nav, sheet, toast
app.js              state, views, AI loop, sources, export
sb.js               Supabase layer: auth, workshop load, realtime, writes
help.js             tooltips, per-view how-to, the guide
api/                Vercel functions: config, extract (Claude, server key), ingest (bridge)
supabase/schema.sql tables, policies, triggers, RPCs, realtime
styles.css          tokens and composition on top of the scroll-craft floor
data/seed.js        client context, run sheet, phases, systems, question bank, blind spots, demo transcript
engine/             scroll-craft engine (unmodified) used for the reveal
vendor/             SheetJS for the Excel export
docs/               workshop plan and the Wispr Flow bridge prompt
```

Edit `data/seed.js` to change the client, the agenda, the phases or the prepared blind spots. Nothing else needs touching for a different workshop.

## Data model

Each opportunity carries: id, title, function, phase, cluster, surface, build, pain, direction, systems, quote, raisedBy, owner, status, source, confidence, votes, value, ease, notes. The Excel export writes five tabs: Opportunity Register, New Ideas, Systems, Lifecycle Map, Read Me. Value and Ease columns are left blank for the prioritisation session.

## Privacy

The API key never leaves this browser and never syncs. Transcript text is sent to Claude in windows for extraction. Tell the room at the start, and keep customer names and serial numbers out of the conversation, or out of the transcript source.

## Credits

Design floor from [scroll-craft](https://github.com/nateherkai/scroll-craft) (MIT). Control patterns checked against [apple-design-skill](https://github.com/dickwu/apple-design-skill). Excel via SheetJS (Apache 2.0).
