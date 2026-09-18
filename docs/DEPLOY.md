# Deploying the board

Three parts: the static page plus two small server functions on Vercel, the database and login on Supabase, and the transcript bridge.

## 1. Supabase (database, login, live votes)

1. Create a project at supabase.com. Region: Sydney (ap-southeast-2) for Melbourne users.
2. Open **SQL Editor**, paste the whole of `supabase/schema.sql`, run it. It is safe to run twice.
3. **Authentication → Providers → Email**: keep Email on. Turn **Confirm email** off (magic links already prove the address). Leave "Enable email OTP" on.
   **Authentication → Providers → Anonymous** (Supabase calls it "Allow anonymous sign-ins"): turn it **on**. Participants scan the QR on the screen, type a name and are in; that path signs them in anonymously. Without this toggle the phone falls back to email. Under **Rate limits**, "anonymous users" defaults to 30 an hour per IP address; a room on one Wi-Fi shares an IP, so raise it if the room is bigger than about twenty.
4. **Authentication → URL Configuration**:
   - Site URL: your Vercel URL, for example `https://ideation-workshop-three.vercel.app`
   - Redirect URLs: add `https://ideation-workshop-three.vercel.app/**` and `http://localhost:8765/**`
5. **Email sending**: Supabase's own mailer sends 2 emails an hour. Participants no longer need email (they scan the QR), so this only bites facilitators signing in on a new device. Still worth fixing before the day. Resend is the simplest provider:
   1. At resend.com add your domain (Domains → Add) and put its three DNS records (SPF TXT, DKIM TXT, MX) at your DNS host. Cloudflare: proxy off on those records. Press Verify; allow up to a few hours.
   2. API Keys → Create, permission "Sending access", scoped to that domain. Copy it once.
   3. Supabase **Project Settings → Authentication → SMTP Settings** → Enable custom SMTP: sender `noreply@yourdomain`, sender name "Ideation Board", host `smtp.resend.com`, port `465`, username `resend`, password the API key. Save.
   4. **Authentication → Rate limits** → "Rate limit for sending emails": custom SMTP unlocks it (default 30 an hour). Set 100. One link per address per 60 seconds still applies.
   5. Test: sign out on the live site, request a link to an address you have not used, check it arrives from your domain, and check Resend → Logs.
   No domain to hand? Gmail works: host `smtp.gmail.com`, port `465`, username your Gmail address, password a Google app password. About 500 a day.
6. Copy from **Project Settings → API**: Project URL, anon public key, service_role key.

## 2. Vercel (hosting)

1. Import the GitHub repository `WeAreGoodVibe/Ideation-workshop` at vercel.com/new. Framework preset: **Other**. No build command. Output directory: leave blank (the root is the site).
2. **Settings → Environment Variables**, all environments:

| Name | Value | Used by |
|---|---|---|
| `SUPABASE_URL` | Project URL | `/api/config`, `/api/extract`, `/api/ingest` |
| `SUPABASE_ANON_KEY` | anon public key | `/api/config` (sent to the browser, safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | a secret key: **Project Settings → API Keys → Secret keys → Create new secret key** (`sb_secret_…`), or the legacy `service_role` JWT from the Legacy tab | `/api/ingest` only (the transcript bridge). `/api/extract` checks the facilitator with the caller's own token and does not need it. Never sent to a browser. The code sends an `sb_secret_` key on the `apikey` header only, as Supabase requires. A wrong value shows up as `supabase 401: Invalid API key` from `/api/ingest`. To fix: create a new secret key, paste it over the Vercel variable for Production, Preview and Development, then Deployments → latest → Redeploy. Functions only read variables at deploy time. |
| `ANTHROPIC_API_KEY` | your key | `/api/extract`: the listening loop and the second viewpoint |
| `ANTHROPIC_MODEL` | optional, default `claude-opus-5` | `/api/extract` |

3. Redeploy. Open the site: you should see the sign-in screen, not the local board. If you see the local board, `/api/config` is returning empty values: check the variables.

## 3. First run

1. Open the site, enter your name and email, press **Email me a link**. Open the link.
2. You land on Settings with no workshop. Under **Workshops → New workshop**: new organisation "Watches of Switzerland", title, client name, teams, join code. Create. You are its facilitator.
3. The Run sheet now shows the join card: a QR code, the **join link** (the QR as text, workshop and code included) and the code. Press **Show big** on the projector. Everyone in the room scans the square with their phone camera, types their name and lands on the Opportunities view with three dots to spend. No email. Someone joining from their desk opens the join link instead: copy it from the join card, from Settings → This workshop, or from the Workshops list, and send it by email or Teams. Facilitators still sign in by emailed link so their role follows them between devices.
4. A new workshop is a blank slate: no systems, no process phases, no prepared second viewpoint ideas, and a run sheet with one process walk block per team you named. Add systems and phases in the board before the day (Systems → Add a system; Process walk → Add a phase), or let Claude add the ones the room names while Live capture runs. A workshop created before this change still carries the Watches of Switzerland template: Settings → This workshop → **Start blank** removes it and keeps the workshop's own opportunities, votes and transcript.

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
