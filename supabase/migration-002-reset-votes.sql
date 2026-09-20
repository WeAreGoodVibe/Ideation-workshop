-- ============================================================================
-- Migration 002: reset_votes
--
-- Run this once in the Supabase SQL editor (Database > SQL) on a project that
-- already has schema.sql. It is additive and idempotent: it creates one new
-- function and grants it. Nothing already running changes, because nothing
-- already deployed calls it. A fresh project gets this from schema.sql and
-- does not need to run this file.
--
-- Why it is needed: row level security lets a person delete only their own
-- vote rows (policy votes_own, user_id = auth.uid()). A facilitator clearing
-- the room's votes is therefore impossible from the browser. This function
-- runs as the definer and does the facilitator check itself.
--
-- To undo:  drop function if exists public.reset_votes(uuid, uuid);
-- ============================================================================

create or replace function public.reset_votes(p_ws uuid, p_opp uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not public.ws_facilitator(p_ws) then raise exception 'facilitators only'; end if;
  if p_opp is null then
    delete from votes where workshop_id = p_ws;
  else
    delete from votes where workshop_id = p_ws and opportunity_id = p_opp;
  end if;
  get diagnostics n = row_count;
  return n;
end; $$;

revoke execute on function public.reset_votes(uuid, uuid) from public, anon;
grant execute on function public.reset_votes(uuid, uuid) to authenticated;
