# Wispr Flow bridge

Two ways to get the meeting recorder transcript into the board.

## Path A: the Artifact calls the connector itself

When the page is published as a claude.ai Artifact with the Wispr Flow connector declared, Live capture has a "Wispr Flow meeting" source. Pick the meeting in Settings, press start, and the page polls `get_meeting` every 45 seconds with a moving `start_char`.

**Untested assumption:** that `get_meeting` returns transcript text for a meeting that is still recording. If it only returns text once the meeting is finalised, use Path B for the live loop and Path A afterwards for the full second pass.

## Path B: a Claude session polls and writes a feed

Open Claude Code or Cowork in a folder the board can read from (a GitHub Pages branch, a Dropbox public link, or a local static server). Paste this prompt:

```
You are the listening bridge for a live workshop. Every 60 seconds, until I say stop:

1. Call the Wispr Flow tool get_meeting for meeting id <MEETING_ID> with
   view_transcript set to the character offset after the last text you read.
2. Read only the new text. For each real task, pain, volume or repeated artefact
   someone described, write one opportunity with: title (verb-led, at most twelve
   words), function (Finance | Purchasing | Both | Org-wide), phase (one of the
   process phases in data/seed.js), surface (Claude Chat | Claude Project |
   Scheduled Task | Cowork | Skill | Connector setup), build (Skill | Scheduled task
   | Setup | Project | Workflow redesign), pain (one sentence in their words),
   direction (what Claude does, input and output named), systems, quote (verbatim
   fragment), raisedBy. Zero is a valid answer. Never repeat an opportunity already
   in the file.
3. Append the new opportunities to feed.json in the shape
   {"opportunities":[...], "transcript":[{"t": <epoch ms>, "text": "<new text>"}]}
   and commit and push it (or save it where the board's feed URL points).

Context: Watches of Switzerland, Finance and Purchasing, north star is hours
returned at constant headcount. Keep customer names and serial numbers out of
the file.
```

On the board: Settings, Feed URL, then Live capture, JSON feed URL. The page polls every 30 seconds, dedupes on id or title, and drops each new idea onto the board with a number.

## After the session

Run the engagement skill's transcript intake over the finalised Wispr Flow meeting to fill the full workbook with sourced quotes. The board's export is the register; the intake adds the evidence chain.
