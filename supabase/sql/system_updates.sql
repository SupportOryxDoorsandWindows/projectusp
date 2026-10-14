-- "What's New & Updates" (bell, panel, history page, publishing form in
-- updates.js). Two tables in the existing project, same sign-in and roles.
--
-- system_updates: one row per announcement. Admins (is_admin()) create,
--   edit and delete; everyone else (active staff) reads PUBLISHED rows only.
--   Drafts are visible to Admins only. The database, not the browser, sets
--   who created it, who published it and when (trigger
--   system_updates_stamp), so those can't be faked.
-- system_update_reads: one row per (update, person) = "this person has read
--   it". A person can only add / change their OWN rows, only for published
--   updates, and only while their account is active. unique (update_id,
--   user_id) stops duplicates.
--
-- Not to be confused with the Activity / audit logs (inventory_transactions,
-- delete_audit_log, account_activity_log): those record what people did;
-- this records what changed in the system.

create table if not exists public.system_updates (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 150),
  category text not null check (category in ('new_feature', 'improvement', 'bug_fix', 'important')),
  summary text not null check (length(btrim(summary)) between 1 and 500),
  details text check (details is null or length(details) <= 10000),
  version text check (version is null or length(version) <= 40),
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_by uuid references auth.users (id) on delete set null,
  publisher_id uuid references auth.users (id) on delete set null,
  publisher_name text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  check (status = 'draft' or published_at is not null)
);
create index if not exists system_updates_published_idx on public.system_updates (status, published_at desc);
comment on table public.system_updates is
  'What''s New & Updates announcements. Admins write, active staff read published rows. Stamps set by trigger system_updates_stamp.';

create table if not exists public.system_update_reads (
  id bigint generated always as identity primary key,
  update_id uuid not null references public.system_updates (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  is_read boolean not null default true,
  read_at timestamptz not null default now(),
  unique (update_id, user_id)
);
create index if not exists system_update_reads_user_idx on public.system_update_reads (user_id);
comment on table public.system_update_reads is
  'Which published updates each person has read. Each person writes only their own rows.';

-- Who did it and when, set here so the browser can't choose them.
create or replace function public.system_updates_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  select coalesce(nullif(btrim(full_name), ''), email) into v_name
  from public.user_profiles where user_id = auth.uid();

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.publisher_id := null; new.publisher_name := null; new.published_at := null;
  else
    new.id := old.id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.publisher_id := old.publisher_id;
    new.publisher_name := old.publisher_name;
    new.published_at := old.published_at;
  end if;

  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    -- Published now: by this person, at this moment.
    new.publisher_id := auth.uid();
    new.publisher_name := v_name;
    new.published_at := now();
  elsif new.status = 'draft' then
    -- Back to draft (or never published): hidden again, no publish stamp.
    new.publisher_id := null; new.publisher_name := null; new.published_at := null;
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function public.system_updates_stamp() from public, anon, authenticated;

drop trigger if exists system_updates_stamp on public.system_updates;
create trigger system_updates_stamp
  before insert or update on public.system_updates
  for each row execute function public.system_updates_stamp();

-- Row Level Security
alter table public.system_updates enable row level security;
alter table public.system_update_reads enable row level security;

revoke all on public.system_updates from anon;
revoke all on public.system_update_reads from anon;
revoke all on public.system_updates from authenticated;
revoke all on public.system_update_reads from authenticated;
grant select, insert, update, delete on public.system_updates to authenticated;
grant select, insert, update on public.system_update_reads to authenticated;

create policy "Staff read published updates, Admins read all" on public.system_updates
  for select to authenticated
  using ((status = 'published' and (select public.is_active_staff())) or (select public.is_admin()));
create policy "Admins add updates" on public.system_updates
  for insert to authenticated
  with check ((select public.is_admin()));
create policy "Admins change updates" on public.system_updates
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
create policy "Admins remove updates" on public.system_updates
  for delete to authenticated
  using ((select public.is_admin()));

create policy "Read own read-status" on public.system_update_reads
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "Mark published updates read for yourself" on public.system_update_reads
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select public.is_active_staff())
    and exists (select 1 from public.system_updates u where u.id = update_id and u.status = 'published'));
create policy "Change own read-status" on public.system_update_reads
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (select public.is_active_staff())
    and exists (select 1 from public.system_updates u where u.id = update_id and u.status = 'published'));

-- Instant bell (Supabase Realtime): the browser is told when a row changes.
-- Realtime applies the SELECT policy above per person, so staff are only
-- told about published updates (deleted rows send just their id).
alter publication supabase_realtime add table public.system_updates;

-- Applied 2026-10-14 in three parts (tables / stamp trigger / rules). The
-- Supabase connector hangs on SQL containing DROP or DELETE (and on ";"
-- inside a quoted name), so the "drop trigger if exists" line above was left
-- out there; it is harmless in the SQL editor.
--
-- Undo (removes the feature's data):
--   drop table public.system_update_reads; drop table public.system_updates;
--   drop function public.system_updates_stamp();
