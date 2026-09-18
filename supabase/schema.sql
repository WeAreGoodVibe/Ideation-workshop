-- ============================================================================
-- Ideation Board: Supabase schema
-- Run this once in the Supabase SQL editor (Database > SQL) on a fresh project.
-- Safe to re-run: every statement is idempotent or guarded.
--
-- Shape:
--   orgs            one row per client organisation (Watches of Switzerland, ...)
--   org_members     who belongs to an org and whether they facilitate or take part
--   workshops       one session; carries the template config (phases, agenda, ...)
--   systems         the tech stack for a workshop (anyone in the room can add)
--   phases          the process phases for a workshop (anyone in the room can add)
--   opportunities   the register
--   votes           dot votes, one row per person per idea, budget enforced
--   transcript_chunks  facilitator-only transcript
--   second_ideas    the second viewpoint (prepared + AI-written)
--   workshop_secrets   bridge token for a Claude session that writes transcript
--
-- Roles: facilitator (runs the room, edits everything) and participant (votes,
-- adds ideas, reads). Row level security enforces it; the app only hides UI.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables --
create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('facilitator', 'participant')),
  display_name text,
  email text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists public.workshops (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  slug text not null unique,
  title text not null,
  join_code text not null,
  status text not null default 'draft' check (status in ('draft', 'live', 'closed')),
  current_block int not null default -1,
  block_started_at timestamptz,
  timer_running boolean not null default false,
  timer_elapsed_ms bigint not null default 0,
  revealed boolean not null default false,
  max_dots int not null default 3,
  consumed_chars int not null default 0,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workshop_secrets (
  workshop_id uuid primary key references public.workshops(id) on delete cascade,
  bridge_token text not null default encode(gen_random_bytes(18), 'hex')
);

create table if not exists public.systems (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  name text not null,
  category text default '',
  used_by text default '',
  connector text default '',
  status text not null default 'assumed' check (status in ('confirmed', 'assumed', 'unknown')),
  note text default '',
  sort int not null default 0
);
-- who added a system: the facilitator, a participant from their phone, or
-- Claude from the transcript. Participants may only touch their own rows.
alter table public.systems add column if not exists source text not null default 'Facilitator';
alter table public.systems add column if not exists added_by text default '';
alter table public.systems add column if not exists created_by uuid references auth.users(id) on delete set null;
alter table public.systems drop constraint if exists systems_source_check;
alter table public.systems add constraint systems_source_check check (source in ('Facilitator', 'Participant', 'AI'));

-- process phases are rows (not workshop config) so participants can add
-- them and every screen sees them live
create table if not exists public.phases (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  fn text not null default '',
  name text not null,
  what text default '',
  prompts text[] not null default '{}',
  source text not null default 'Facilitator' check (source in ('Facilitator', 'Participant', 'AI')),
  added_by text default '',
  created_by uuid references auth.users(id) on delete set null,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  seq int not null default 0,
  title text not null,
  fn text not null default 'Both',
  phase text default '',
  cluster text default '',
  surface text default 'Claude Chat',
  build text default 'Skill',
  pain text default '',
  direction text default '',
  systems text[] not null default '{}',
  quote text default '',
  raised_by text default 'Room',
  owner text default '',
  status text not null default 'Open' check (status in ('Open', 'Validated', 'Emerging', 'Parked', 'Merged')),
  source text not null default 'Room',
  confidence text default 'Medium',
  notes text default '',
  value int,
  ease int,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workshop_id, seq)
);

create table if not exists public.votes (
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  dots int not null default 1 check (dots >= 0),
  updated_at timestamptz not null default now(),
  primary key (opportunity_id, user_id)
);

create table if not exists public.transcript_chunks (
  id bigserial primary key,
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  t timestamptz not null default now(),
  text text not null,
  src text default 'manual'
);

create table if not exists public.second_ideas (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  key text,
  title text not null,
  fn text default 'Both',
  phase text default '',
  surface text default '',
  build text default '',
  what text default '',
  why text default '',
  lift text default '',
  comparator text default '',
  confidence text default 'Medium',
  origin text not null default 'consultant' check (origin in ('consultant', 'ai')),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists opportunities_workshop_idx on public.opportunities(workshop_id);
create index if not exists votes_workshop_idx on public.votes(workshop_id);
create index if not exists transcript_workshop_idx on public.transcript_chunks(workshop_id, id);
create index if not exists systems_workshop_idx on public.systems(workshop_id);
create index if not exists phases_workshop_idx on public.phases(workshop_id);
create index if not exists second_ideas_workshop_idx on public.second_ideas(workshop_id);

-- --------------------------------------------------------------- helpers --
create or replace function public.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members where org_id = p_org and user_id = auth.uid());
$$;

create or replace function public.is_facilitator(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members where org_id = p_org and user_id = auth.uid() and role = 'facilitator');
$$;

create or replace function public.workshop_org(p_ws uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from workshops where id = p_ws;
$$;

create or replace function public.ws_member(p_ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(public.workshop_org(p_ws));
$$;

create or replace function public.ws_facilitator(p_ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_facilitator(public.workshop_org(p_ws));
$$;

-- -------------------------------------------------------------- triggers --
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

drop trigger if exists workshops_touch on public.workshops;
create trigger workshops_touch before update on public.workshops for each row execute function public.touch_updated_at();
drop trigger if exists opportunities_touch on public.opportunities;
create trigger opportunities_touch before update on public.opportunities for each row execute function public.touch_updated_at();

-- creator of an org becomes its first facilitator
create or replace function public.org_creator_is_facilitator() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is not null then
    insert into org_members (org_id, user_id, role, display_name, email)
    select new.id, new.created_by, 'facilitator', coalesce(u.raw_user_meta_data->>'display_name', split_part(u.email, '@', 1)), u.email
    from auth.users u where u.id = new.created_by
    on conflict do nothing;
  end if;
  return new;
end; $$;
drop trigger if exists orgs_creator on public.orgs;
create trigger orgs_creator after insert on public.orgs for each row execute function public.org_creator_is_facilitator();

-- a new workshop gets a secret and its seed rows from config
create or replace function public.workshop_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare s jsonb; i int := 0;
begin
  insert into workshop_secrets (workshop_id) values (new.id) on conflict do nothing;
  for s in select * from jsonb_array_elements(coalesce(new.config->'systems', '[]'::jsonb)) loop
    i := i + 1;
    insert into systems (workshop_id, name, category, used_by, connector, status, note, sort)
    values (new.id, s->>'name', coalesce(s->>'category', ''), coalesce(s->>'usedBy', ''), coalesce(s->>'connector', ''), coalesce(s->>'status', 'assumed'), coalesce(s->>'note', ''), i);
  end loop;
  i := 0;
  for s in select * from jsonb_array_elements(coalesce(new.config->'phases', '[]'::jsonb)) loop
    i := i + 1;
    insert into phases (workshop_id, fn, name, what, prompts, source, sort)
    values (new.id, coalesce(s->>'fn', ''), s->>'name', coalesce(s->>'what', ''),
      coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s->'prompts', '[]'::jsonb)) x), '{}'), 'Facilitator', i);
  end loop;
  i := 0;
  for s in select * from jsonb_array_elements(coalesce(new.config->'blindSpots', '[]'::jsonb)) loop
    i := i + 1;
    insert into second_ideas (workshop_id, key, title, fn, phase, surface, build, what, why, lift, comparator, confidence, origin, sort)
    values (new.id, s->>'id', s->>'title', coalesce(s->>'fn', 'Both'), coalesce(s->>'phase', ''), coalesce(s->>'surface', ''), coalesce(s->>'build', ''), coalesce(s->>'what', ''), coalesce(s->>'why', ''), coalesce(s->>'lift', ''), coalesce(s->>'comparator', ''), coalesce(s->>'confidence', 'Medium'), 'consultant', i);
  end loop;
  return new;
end; $$;
drop trigger if exists workshops_after_insert on public.workshops;
create trigger workshops_after_insert after insert on public.workshops for each row execute function public.workshop_after_insert();

-- rows remember who made them, so a participant can edit and delete their own
create or replace function public.stamp_created_by() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.created_by is null then new.created_by = auth.uid(); end if;
  return new;
end; $$;
drop trigger if exists systems_created_by on public.systems;
create trigger systems_created_by before insert on public.systems for each row execute function public.stamp_created_by();
drop trigger if exists phases_created_by on public.phases;
create trigger phases_created_by before insert on public.phases for each row execute function public.stamp_created_by();

-- one-off: phases that older workshops kept in config become rows
insert into public.phases (workshop_id, fn, name, what, prompts, source, sort)
select w.id, coalesce(p.value->>'fn', ''), p.value->>'name', coalesce(p.value->>'what', ''),
       coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p.value->'prompts', '[]'::jsonb)) x), '{}'), 'Facilitator', p.ordinality
from public.workshops w, jsonb_array_elements(coalesce(w.config->'phases', '[]'::jsonb)) with ordinality p
where not exists (select 1 from public.phases ph where ph.workshop_id = w.id);
update public.workshops set config = config - 'phases' where config ? 'phases';

-- opportunities get the next number in the workshop. The advisory lock
-- serialises inserts per workshop: the extractor adds several ideas at once
-- and without it two of them read the same max(seq) and one insert fails.
create or replace function public.opportunity_seq() returns trigger
language plpgsql as $$
begin
  if new.seq is null or new.seq = 0 then
    perform pg_advisory_xact_lock(hashtext('opportunity_seq:' || new.workshop_id::text));
    select coalesce(max(seq), 0) + 1 into new.seq from opportunities where workshop_id = new.workshop_id;
  end if;
  if new.created_by is null then new.created_by = auth.uid(); end if;
  return new;
end; $$;
drop trigger if exists opportunities_seq on public.opportunities;
create trigger opportunities_seq before insert on public.opportunities for each row execute function public.opportunity_seq();

-- a person cannot spend more dots than the workshop allows
create or replace function public.check_vote_budget() returns trigger
language plpgsql security definer set search_path = public as $$
declare total int; allowed int;
begin
  select max_dots into allowed from workshops where id = new.workshop_id;
  select coalesce(sum(dots), 0) into total from votes
    where workshop_id = new.workshop_id and user_id = new.user_id and opportunity_id <> new.opportunity_id;
  if total + new.dots > allowed then
    raise exception 'vote budget exceeded: % of % dots used', total, allowed using errcode = 'check_violation';
  end if;
  new.updated_at = now();
  return new;
end; $$;
drop trigger if exists votes_budget on public.votes;
create trigger votes_budget before insert or update on public.votes for each row execute function public.check_vote_budget();

-- ------------------------------------------------------------------ rpcs --
-- Join a workshop with its code. Adds the caller as a participant.
create or replace function public.join_workshop(p_slug text, p_code text, p_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare w workshops%rowtype; u_email text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into w from workshops where slug = p_slug;
  if w.id is null then raise exception 'no such workshop'; end if;
  if lower(trim(w.join_code)) <> lower(trim(coalesce(p_code, ''))) and not public.is_member(w.org_id) then
    raise exception 'wrong join code';
  end if;
  select email into u_email from auth.users where id = auth.uid();
  insert into org_members (org_id, user_id, role, display_name, email)
  values (w.org_id, auth.uid(), 'participant', coalesce(nullif(trim(p_name), ''), split_part(u_email, '@', 1)), u_email)
  on conflict (org_id, user_id) do update set display_name = coalesce(nullif(trim(p_name), ''), org_members.display_name);
  return w.id;
end; $$;

-- Cast or remove a dot. Returns the caller's dots on that idea.
create or replace function public.cast_vote(p_opp uuid, p_delta int)
returns int language plpgsql security definer set search_path = public as $$
declare w uuid; cur int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select workshop_id into w from opportunities where id = p_opp;
  if w is null or not public.ws_member(w) then raise exception 'not a member'; end if;
  select dots into cur from votes where opportunity_id = p_opp and user_id = auth.uid();
  cur := greatest(0, coalesce(cur, 0) + p_delta);
  if cur = 0 then
    delete from votes where opportunity_id = p_opp and user_id = auth.uid();
  else
    insert into votes (workshop_id, opportunity_id, user_id, dots) values (w, p_opp, auth.uid(), cur)
    on conflict (opportunity_id, user_id) do update set dots = excluded.dots;
  end if;
  return cur;
end; $$;

-- Who am I in this org, and what can I do.
create or replace function public.my_role(p_ws uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from org_members where org_id = public.workshop_org(p_ws) and user_id = auth.uid();
$$;

-- ------------------------------------------------------------------ view --
create or replace view public.vote_tallies with (security_invoker = true) as
  select v.workshop_id, v.opportunity_id, sum(v.dots)::int as total, count(*)::int as voters,
         array_agg(coalesce(m.display_name, 'someone') order by m.display_name) as names
  from votes v
  left join opportunities o on o.id = v.opportunity_id
  left join org_members m on m.user_id = v.user_id and m.org_id = public.workshop_org(v.workshop_id)
  group by v.workshop_id, v.opportunity_id;

-- ------------------------------------------------------------------- rls --
alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.workshops enable row level security;
alter table public.workshop_secrets enable row level security;
alter table public.systems enable row level security;
alter table public.phases enable row level security;
alter table public.opportunities enable row level security;
alter table public.votes enable row level security;
alter table public.transcript_chunks enable row level security;
alter table public.second_ideas enable row level security;

drop policy if exists orgs_select on public.orgs;
create policy orgs_select on public.orgs for select using (public.is_member(id) or created_by = auth.uid());
drop policy if exists orgs_insert on public.orgs;
create policy orgs_insert on public.orgs for insert with check (auth.uid() is not null and created_by = auth.uid());
drop policy if exists orgs_update on public.orgs;
create policy orgs_update on public.orgs for update using (public.is_facilitator(id));

drop policy if exists members_select on public.org_members;
create policy members_select on public.org_members for select using (public.is_member(org_id));
drop policy if exists members_update on public.org_members;
create policy members_update on public.org_members for update using (public.is_facilitator(org_id) or user_id = auth.uid());
drop policy if exists members_delete on public.org_members;
create policy members_delete on public.org_members for delete using (public.is_facilitator(org_id));
drop policy if exists members_insert on public.org_members;
create policy members_insert on public.org_members for insert with check (public.is_facilitator(org_id));

drop policy if exists workshops_select on public.workshops;
create policy workshops_select on public.workshops for select using (public.is_member(org_id));
drop policy if exists workshops_write on public.workshops;
create policy workshops_write on public.workshops for all using (public.is_facilitator(org_id)) with check (public.is_facilitator(org_id));

drop policy if exists secrets_select on public.workshop_secrets;
create policy secrets_select on public.workshop_secrets for select using (public.ws_facilitator(workshop_id));

drop policy if exists systems_select on public.systems;
create policy systems_select on public.systems for select using (public.ws_member(workshop_id));
drop policy if exists systems_write on public.systems;
drop policy if exists systems_fac on public.systems;
create policy systems_fac on public.systems for all using (public.ws_facilitator(workshop_id)) with check (public.ws_facilitator(workshop_id));
drop policy if exists systems_member_insert on public.systems;
create policy systems_member_insert on public.systems for insert
  with check (public.ws_member(workshop_id) and source = 'Participant');
drop policy if exists systems_member_update on public.systems;
create policy systems_member_update on public.systems for update
  using (public.ws_member(workshop_id) and created_by = auth.uid() and source = 'Participant');
drop policy if exists systems_member_delete on public.systems;
create policy systems_member_delete on public.systems for delete
  using (public.ws_member(workshop_id) and created_by = auth.uid() and source = 'Participant');

drop policy if exists phases_select on public.phases;
create policy phases_select on public.phases for select using (public.ws_member(workshop_id));
drop policy if exists phases_fac on public.phases;
create policy phases_fac on public.phases for all using (public.ws_facilitator(workshop_id)) with check (public.ws_facilitator(workshop_id));
drop policy if exists phases_member_insert on public.phases;
create policy phases_member_insert on public.phases for insert
  with check (public.ws_member(workshop_id) and source = 'Participant');
drop policy if exists phases_member_update on public.phases;
create policy phases_member_update on public.phases for update
  using (public.ws_member(workshop_id) and created_by = auth.uid() and source = 'Participant');
drop policy if exists phases_member_delete on public.phases;
create policy phases_member_delete on public.phases for delete
  using (public.ws_member(workshop_id) and created_by = auth.uid() and source = 'Participant');

drop policy if exists opps_select on public.opportunities;
create policy opps_select on public.opportunities for select using (public.ws_member(workshop_id));
drop policy if exists opps_fac on public.opportunities;
create policy opps_fac on public.opportunities for all using (public.ws_facilitator(workshop_id)) with check (public.ws_facilitator(workshop_id));
drop policy if exists opps_participant_insert on public.opportunities;
create policy opps_participant_insert on public.opportunities for insert
  with check (public.ws_member(workshop_id) and source = 'Participant');
drop policy if exists opps_participant_update on public.opportunities;
create policy opps_participant_update on public.opportunities for update
  using (public.ws_member(workshop_id) and created_by = auth.uid() and source = 'Participant');
drop policy if exists opps_participant_delete on public.opportunities;
create policy opps_participant_delete on public.opportunities for delete
  using (public.ws_member(workshop_id) and created_by = auth.uid() and source = 'Participant');

drop policy if exists votes_select on public.votes;
create policy votes_select on public.votes for select using (public.ws_member(workshop_id));
drop policy if exists votes_own on public.votes;
create policy votes_own on public.votes for all using (user_id = auth.uid()) with check (user_id = auth.uid() and public.ws_member(workshop_id));

drop policy if exists transcript_fac on public.transcript_chunks;
create policy transcript_fac on public.transcript_chunks for all using (public.ws_facilitator(workshop_id)) with check (public.ws_facilitator(workshop_id));

drop policy if exists second_select on public.second_ideas;
create policy second_select on public.second_ideas for select using (public.ws_member(workshop_id));
drop policy if exists second_write on public.second_ideas;
create policy second_write on public.second_ideas for all using (public.ws_facilitator(workshop_id)) with check (public.ws_facilitator(workshop_id));

grant usage on schema public to anon, authenticated;
grant select on public.vote_tallies to authenticated;
grant execute on function public.join_workshop(text, text, text) to authenticated;
grant execute on function public.cast_vote(uuid, int) to authenticated;
grant execute on function public.my_role(uuid) to authenticated;

-- -------------------------------------------------------------- realtime --
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
do $$
declare t text;
begin
  foreach t in array array['workshops', 'systems', 'phases', 'opportunities', 'votes', 'second_ideas'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
alter table public.votes replica identity full;
alter table public.opportunities replica identity full;
alter table public.votes drop constraint if exists votes_dots_check;
alter table public.votes add constraint votes_dots_check check (dots >= 0);
alter table public.systems replica identity full;
alter table public.phases replica identity full;

-- -------------------------------------------------------------- hardening --
-- Helpers are for signed-in users only; trigger functions need no callers.
revoke execute on all functions in schema public from public, anon;
revoke execute on function public.touch_updated_at(), public.opportunity_seq(), public.check_vote_budget(), public.org_creator_is_facilitator(), public.workshop_after_insert(), public.stamp_created_by() from authenticated;
alter function public.touch_updated_at() set search_path = public;
alter function public.opportunity_seq() set search_path = public;
grant execute on function public.is_member(uuid), public.is_facilitator(uuid), public.workshop_org(uuid), public.ws_member(uuid), public.ws_facilitator(uuid), public.join_workshop(text, text, text), public.cast_vote(uuid, int), public.my_role(uuid) to authenticated;
