-- Undo migration 003. Drops every register table and the columns it added
-- to opportunities, and restores the old status check. Any Opportunity whose
-- status is one of the new values is set back to Open first.
drop view if exists public.opportunity_blocked;
drop table if exists public.enabler_links, public.register_items, public.enablers, public.learning_items,
  public.triage_items, public.register_aliases, public.register_log, public.register_counters cascade;
drop function if exists public.register_stamp(), public.enabler_link_check(), public.register_next(uuid, text), public.register_move_votes(uuid, uuid);
update public.opportunities set status = 'Open' where status in ('Identified', 'Qualified', 'In build', 'Built', 'In use');
alter table public.opportunities drop constraint if exists opportunities_status_check;
alter table public.opportunities add constraint opportunities_status_check check (status in ('Open', 'Validated', 'Emerging', 'Parked', 'Merged'));
alter table public.opportunities drop constraint if exists opportunities_time_band_check, drop constraint if exists opportunities_origin_check,
  drop constraint if exists opportunities_created_via_check;
alter table public.opportunities drop column if exists frequency, drop column if exists time_band, drop column if exists origin,
  drop column if exists confirmed, drop column if exists evidence, drop column if exists created_via, drop column if exists legacy_ref;
