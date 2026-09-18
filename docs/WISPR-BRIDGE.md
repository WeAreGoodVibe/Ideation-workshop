# Wispr Flow bridge

Wispr Flow exposes meetings through a remote MCP server (`https://api.wisprflow.ai/connect/mcp`, OAuth). Claude connectors can reach it. A website on Vercel cannot, because the OAuth grant lives inside the Claude account. So the transcript reaches the board one of three ways.

## Path A: dictation (always works)

Open Live capture, click in the box, press the Wispr Flow hotkey, summarise what was just said in a sentence, press Add to transcript. Claude reads it on the next pass. This is the fallback on the day and it is enough for the extractor.

## Path B: a Claude session posts into the workshop (recommended for the live loop)

Open Claude Code or Cowork with the Wispr Flow connector. From the board's Settings, copy the **workshop id** and the **bridge token**. Paste this prompt, filling in the four values:

```
You are the listening bridge for a live workshop. Every 60 seconds, until I say stop:

1. Call the Wispr Flow tool get_meeting for meeting id <MEETING_ID> with
   view_transcript set to { start_char: <offset after the last text you read>, char_limit: 40000 }.
2. Read only the new text. For each real task, pain, volume or repeated artefact
   someone described, write one opportunity: title (verb-led, at most twelve words),
   function (Finance | Purchasing | Both | Org-wide), phase (one of the process
   phases in data/seed.js), surface (Claude Chat | Claude Project | Scheduled Task |
   Cowork | Skill | Connector setup), build (Skill | Scheduled task | Setup | Project |
   Workflow redesign), pain (one sentence in their words), direction (what Claude
   does, input and output named), systems, quote (verbatim fragment), raisedBy.
   Zero is a valid answer. Never repeat an opportunity you already posted.
3. POST to https://ideation-workshop-three.vercel.app/api/ingest with header x-bridge-token: <BRIDGE_TOKEN>
   and body {"workshopId": "<WORKSHOP_ID>", "transcript": [{"text": "<new text>", "src": "wispr"}],
   "opportunities": [ ...the new ones... ]}.

Context: Watches of Switzerland, Finance and Purchasing, north star is hours
returned at constant headcount. Keep customer names and serial numbers out of
what you post.
```

The board dedupes on title, so an occasional repeat is harmless. Participants see each idea land within a second.

## Path C: the Artifact calls the connector itself

The claude.ai Artifact build has a "Wispr Flow meeting" source in Live capture that polls `get_meeting` directly. Same untested assumption as below.

## The one thing to test before the day

Whether `get_meeting` returns transcript text for a meeting that is **still recording**. The connector marks meetings `finalized: true` once they end, which suggests in-progress meetings are listed too, but we have not seen one.

Test in ten minutes: start a Wispr Flow Notetaker recording, talk for three minutes, then in any Claude session with the connector ask "search my Wispr Flow meetings and read the transcript of the one in progress". If text comes back, Paths B and C work live. If it only appears after you stop the recording, use Path A during the session and Path B afterwards for the full second pass.

## After the session

Run the engagement skill's transcript intake over the finalised Wispr Flow meeting to fill the full workbook with sourced quotes. The board's export is the register; the intake adds the evidence chain.
