-- ============================================================================
-- Migration 003: the hierarchical register
--
-- Additive and idempotent. Run once on a project that already has schema.sql
-- and migration 002; a fresh project gets all of this from schema.sql.
--
-- Nothing already deployed breaks:
--   * opportunities gains nullable or defaulted columns only;
--   * its status check is widened to accept the old values (Open, Validated,
--     Emerging, Parked, Merged) and the new ones (Identified, Qualified,
--     In build, Built, In use, Parked). Rows keep their current status until
--     the page moves to the new model;
--   * every other object is new.
--
-- New:
--   register_items     children of an Opportunity (O3.2), one type each
--   enablers           organisation-wide blockers (E1) and enabler_links
--   learning_items     ways of working and training points (L1)
--   triage_items       captures the classifier was not sure about (T1)
--   register_aliases   old reference -> new reference after a move or merge
--   register_log       every promote, demote, merge and consolidation change
--   register_counters  numbers are issued once and never reused
--   opportunity_blocked  view: Blocked is computed, never stored
--
-- To undo, run supabase/migration-003-register-undo.sql.
-- ============================================================================

-- ---------------------------------------------------------- opportunities --
alter table public.opportunities
  add column if not exists frequency text not null default '',
  add column if not exists time_band text not null default '',
  add column if not exists origin text not null default 'Client-raised',
  add column if not exists confirmed boolean not null default true,
  add column if not exists evidence jsonb not null default '[]'::jsonb,
  add column if not exists created_via text not null default 'live',
  add column if not exists legacy_ref text not null default '';

do $$ begin
  alter table public.opportunities drop constraint if exists opportunities_status_check;
  alter table public.opportunities add constraint opportunities_status_check check (status in
    ('Open', 'Validated', 'Emerging', 'Merged', 'Identified', 'Qualified', 'In build', 'Built', 'In use', 'Parked'));
  if not exists (select 1 from pg_constraint where conname = 'opportunities_time_band_check') then
    alter table public.opportunities add constraint opportunities_time_band_check
      check (time_band in ('', 'Under 15 min', '15 to 60 min', '1 to 4 hours', 'Over 4 hours'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'opportunities_origin_check') then
    alter table public.opportunities add constraint opportunities_origin_check check (origin in ('Client-raised', 'Proposed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'opportunities_created_via_check') then
    alter table public.opportunities add constraint opportunities_created_via_check
      check (created_via in ('live', 'second viewpoint', 'manual', 'migration'));
  end if;
end $$;

-- ------------------------------------------------------------- numbering --
-- One counter per workshop and kind ('E', 'L', 'T', or 'O:<opportunity id>'
-- for that Opportunity's children). Numbers only go up, so an ID is never
-- given to a second item after a delete, a merge or a move.
create table if not exists public.register_counters (
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  kind text not null,
  n int not null default 0,
  primary key (workshop_id, kind)
);
alter table public.register_counters enable row level security;
-- No policies: only the security definer function below touches it.

create or replace function public.register_next(p_ws uuid, p_kind text) returns int
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into register_counters (workshop_id, kind, n) values (p_ws, p_kind, 1)
  on conflict (workshop_id, kind) do update set n = register_counters.n + 1
  returning n into v;
  return v;
end; $$;
revoke all on function public.register_next(uuid, text) from public, anon, authenticated;

-- Before insert: stamp who, and number the row. A child takes its workshop
-- from its Opportunity, so row level security judges it by the workshop it
-- really belongs to. A number passed in is kept (the page assigns O3.2 and must see
-- O3.2 after a reload) and the counter is raised to it; with none given, the
-- counter issues the next. Either way the counter never goes backwards, so a
-- number is never issued twice.
create or replace function public.register_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if tg_op = 'INSERT' and new.created_by is null then new.created_by = auth.uid(); end if;
  if tg_table_name = 'register_items' then
    select workshop_id into new.workshop_id from opportunities where id = new.opportunity_id;
    if tg_op = 'UPDATE' and new.opportunity_id is not distinct from old.opportunity_id then return new; end if;
    k := 'O:' || new.opportunity_id::text;
  elsif tg_op = 'INSERT' then
    k := case tg_table_name when 'enablers' then 'E' when 'learning_items' then 'L' when 'triage_items' then 'T' end;
  else
    return new;
  end if;
  if coalesce(new.seq, 0) > 0 and (tg_op = 'INSERT' or new.seq is distinct from old.seq) then
    insert into register_counters (workshop_id, kind, n) values (new.workshop_id, k, new.seq)
    on conflict (workshop_id, kind) do update set n = greatest(register_counters.n, excluded.n);
  else
    new.seq := public.register_next(new.workshop_id, k);
  end if;
  return new;
end; $$;

-- An Enabler link must join an Enabler and an Opportunity of one workshop.
create or replace function public.enabler_link_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare we uuid; wo uuid;
begin
  select workshop_id into we from enablers where id = new.enabler_id;
  select workshop_id into wo from opportunities where id = new.opportunity_id;
  if we is distinct from wo then raise exception 'enabler and opportunity are in different workshops' using errcode = 'check_violation'; end if;
  new.workshop_id := we;
  return new;
end; $$;

-- ------------------------------------------------------------ the tables --
create table if not exists public.register_items (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  seq int not null default 0,
  type text not null check (type in ('build_step', 'guardrail', 'dependency', 'setup_action', 'open_question')),
  text text not null,
  status text not null default 'Open' check (status in ('Open', 'Done')),
  owner text not null default '',
  blocked_by_kind text not null default '' check (blocked_by_kind in ('', 'opportunity', 'enabler', 'external')),
  blocked_by_ref text not null default '',
  answer_by text not null default '',
  evidence jsonb not null default '[]'::jsonb,
  created_via text not null default 'live' check (created_via in ('live', 'second viewpoint', 'manual', 'migration')),
  auto text not null default '' check (auto in ('', 'owner', 'frequency', 'timeBand')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (opportunity_id, seq)
);
create index if not exists register_items_ws on public.register_items (workshop_id);

create table if not exists public.enablers (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  seq int not null default 0,
  text text not null,
  owner text not null default 'Client' check (owner in ('Client', 'IT provider', 'Consultant')),
  status text not null default 'Open' check (status in ('Open', 'Done')),
  evidence jsonb not null default '[]'::jsonb,
  created_via text not null default 'live' check (created_via in ('live', 'second viewpoint', 'manual', 'migration')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workshop_id, seq)
);

create table if not exists public.enabler_links (
  enabler_id uuid not null references public.enablers(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  primary key (enabler_id, opportunity_id)
);
create index if not exists enabler_links_opp on public.enabler_links (opportunity_id);

create table if not exists public.learning_items (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  seq int not null default 0,
  text text not null,
  module text not null default '',
  evidence jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workshop_id, seq)
);

create table if not exists public.triage_items (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  seq int not null default 0,
  text text not null,
  suggested_type text not null default '',
  suggested_parent text not null default '',
  confidence numeric not null default 0,
  reason text not null default '',
  capture jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workshop_id, seq)
);

create table if not exists public.register_aliases (
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  old_ref text not null,
  new_ref text not null,
  created_at timestamptz not null default now(),
  primary key (workshop_id, old_ref)
);

create table if not exists public.register_log (
  id bigserial primary key,
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  at timestamptz not null default now(),
  by_user uuid default auth.uid() references auth.users(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists register_log_ws on public.register_log (workshop_id, at);

-- -------------------------------------------------------------- triggers --
drop trigger if exists register_items_stamp on public.register_items;
create trigger register_items_stamp before insert or update of opportunity_id on public.register_items for each row execute function public.register_stamp();
drop trigger if exists enablers_stamp on public.enablers;
create trigger enablers_stamp before insert on public.enablers for each row execute function public.register_stamp();
drop trigger if exists learning_items_stamp on public.learning_items;
create trigger learning_items_stamp before insert on public.learning_items for each row execute function public.register_stamp();
drop trigger if exists triage_items_stamp on public.triage_items;
create trigger triage_items_stamp before insert on public.triage_items for each row execute function public.register_stamp();
drop trigger if exists enabler_links_check on public.enabler_links;
create trigger enabler_links_check before insert or update on public.enabler_links for each row execute function public.enabler_link_check();
drop trigger if exists register_items_touch on public.register_items;
create trigger register_items_touch before update on public.register_items for each row execute function public.touch_updated_at();
drop trigger if exists enablers_touch on public.enablers;
create trigger enablers_touch before update on public.enablers for each row execute function public.touch_updated_at();

-- ------------------------------------------------------ blocked, computed --
-- Blocked is never stored: an Opportunity is blocked while it has an open
-- Dependency of its own or a link to an open Enabler. security_invoker keeps
-- the caller's row level security in force through the view.
create or replace view public.opportunity_blocked with (security_invoker = true) as
select o.id as opportunity_id, o.workshop_id,
  (select count(*) from public.register_items i where i.opportunity_id = o.id and i.type = 'dependency' and i.status = 'Open')::int as open_dependencies,
  (select count(*) from public.enabler_links l join public.enablers e on e.id = l.enabler_id where l.opportunity_id = o.id and e.status = 'Open')::int as open_enablers,
  exists (select 1 from public.register_items i where i.opportunity_id = o.id and i.type = 'dependency' and i.status = 'Open')
  or exists (select 1 from public.enabler_links l join public.enablers e on e.id = l.enabler_id where l.opportunity_id = o.id and e.status = 'Open') as blocked
from public.opportunities o;

-- ------------------------------------------------------ row level security --
-- Members read; facilitators write. Participants keep adding their own ideas
-- through the existing opportunities policies.
alter table public.register_items enable row level security;
alter table public.enablers enable row level security;
alter table public.enabler_links enable row level security;
alter table public.learning_items enable row level security;
alter table public.triage_items enable row level security;
alter table public.register_aliases enable row level security;
alter table public.register_log enable row level security;

do $$
declare t text;
begin
  foreach t in array array['register_items', 'enablers', 'enabler_links', 'learning_items', 'triage_items', 'register_aliases', 'register_log'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select using (public.ws_member(workshop_id))', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_fac', t);
    execute format('create policy %I on public.%I for all using (public.ws_facilitator(workshop_id)) with check (public.ws_facilitator(workshop_id))', t || '_fac', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- realtime --
do $$
declare t text;
begin
  foreach t in array array['register_items', 'enablers', 'enabler_links', 'learning_items', 'triage_items'] loop
    execute format('alter table public.%I replica identity full', t);
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

grant select on public.opportunity_blocked to authenticated;

-- Votes follow an Opportunity that is merged or folded into another, instead
-- of being deleted with it. A person who voted on both keeps the sum. Row
-- level security only lets people move their own votes, so this runs as the
-- definer and checks the caller is a facilitator of that workshop.
create or replace function public.register_move_votes(p_from uuid, p_to uuid) returns int
language plpgsql security definer set search_path = public as $$
declare w uuid; w2 uuid; n int := 0; r record;
begin
  select workshop_id into w from opportunities where id = p_from;
  select workshop_id into w2 from opportunities where id = p_to;
  if w is null or w is distinct from w2 then raise exception 'both Opportunities must be in one workshop'; end if;
  if not public.ws_facilitator(w) then raise exception 'facilitators only'; end if;
  for r in select user_id, dots from votes where opportunity_id = p_from loop
    delete from votes where opportunity_id = p_from and user_id = r.user_id;
    insert into votes (workshop_id, opportunity_id, user_id, dots) values (w, p_to, r.user_id, r.dots)
    on conflict (opportunity_id, user_id) do update set dots = votes.dots + excluded.dots;
    n := n + r.dots;
  end loop;
  return n;
end; $$;
revoke all on function public.register_move_votes(uuid, uuid) from public, anon;
grant execute on function public.register_move_votes(uuid, uuid) to authenticated;

-- Trigger functions are not for calling over the API.
revoke all on function public.register_stamp() from public, anon, authenticated;
revoke all on function public.enabler_link_check() from public, anon, authenticated;
