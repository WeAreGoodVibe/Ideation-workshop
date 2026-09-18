# Deploying the board

Three parts: the static page plus two small server functions on Vercel, the database and login on Supabase, and the transcript bridge.

## 1. Supabase (database, login, live votes)

1. Create a project at supabase.com. Region: Sydney (ap-southeast-2) for Melbourne users.
2. Open **SQL Editor**, paste the whole of `supabase/schema.sql`, run it. It is safe to run twice.
3. **Authentication → Providers → Email**: keep Email on. Turn **Confirm email** off (magic links already prove the address). Leave "Enable email OTP" on.
4. **Authentication → URL Configuration**:
   - Site URL: your Vercel URL, for example `https://ideation-board.vercel.app`
   - Redirect URLs: add `https://ideation-board.vercel.app/**` and `http://localhost:8765/**`
5. **Authentication → Rate limits**: the free tier sends 2 magic-link emails an hour through Supabase's own mailer. For a room of eight, set up an SMTP provider (Resend, Postmark, Gmail app password) under **Project Settings → Auth → SMTP** before the day, or you will hit the limit halfway through the join step.
6. Copy from **Project Settings → API**: Project URL, anon public key, service_role key.

## 2. Vercel (hosting)

1. Import the GitHub repository `WeAreGoodVibe/Ideation-workshop` at vercel.com/new. Framework preset: **Other**. No build command. Output directory: leave blank (the root is the site).
2. **Settings → Environment Variables**, all environments:

| Name | Value | Used by |
|---|---|---|
| `SUPABASE_URL` | Project URL | `/api/config`, `/api/extract`, `/api/ingest` |
| `SUPABASE_ANON_KEY` | anon public key | `/api/config` (sent to the browser, safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key | `/api/extract` role check, `/api/ingest` writes. Never sent to a browser. |
| `ANTHROPIC_API_KEY` | your key | `/api/extract`: the listening loop and the second viewpoint |
| `ANTHROPIC_MODEL` | optional, default `claude-opus-5` | `/api/extract` |

3. Redeploy. Open the site: you should see the sign-in screen, not the local board. If you see the local board, `/api/config` is returning empty values: check the variables.

## 3. First run

1. Open the site, enter your name and email, press **Email me a link**. Open the link.
2. You land on Settings with no workshop. Under **Workshops → New workshop**: new organisation "Watches of Switzerland", title, client name, teams, join code. Create. You are its facilitator.
3. The Run sheet now shows the join card: the participant link and the code. Everyone in the room opens the link on their phone, enters name, email and code, and taps the emailed link. They land on the Opportunities view with three dots to spend.

Roles: the person who creates an organisation is its facilitator. Everyone who joins through a code is a participant. To promote someone, in the Supabase table editor set their `org_members.role` to `facilitator`.

## 4. The transcript bridge

The page cannot reach Wispr Flow directly from Vercel: the connector lives inside Claude. Two working paths:

- **Dictation**: press the Wispr Flow hotkey with the cursor in Live capture and summarise as you go. Always works.
- **A Claude session as the bridge**: Claude Code or Cowork with the Wispr Flow connector polls the meeting and posts into the workshop through `/api/ingest` with the workshop's bridge token. Prompt and details in `docs/WISPR-BRIDGE.md`.

The claude.ai Artifact build keeps its own path (the page calls the connector itself) and is unchanged.

## 5. Local development

```
python3 -m http.server 8765
```

Without `/api/config` the page runs in local mode: one browser, localStorage, API key in Settings. To test the backend locally, install the Vercel CLI and run `vercel dev` with the same environment variables in a `.env` file (never commit it).
