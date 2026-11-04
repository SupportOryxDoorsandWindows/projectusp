-- Monthly stock movements report (Freedom + Renson), emailed on the 1st of
-- each month at 06:00 Dubai (02:00 UTC). User's request 2026-11-04.
-- Edge Function: supabase/functions/monthly-report (deploy with verify_jwt
-- OFF -- it checks every caller itself). Nothing here touches stock.
-- Needs the extensions pg_cron (scheduler) and pg_net (HTTP call from the
-- database). No DROP anywhere (the Supabase connector asks a confirmation
-- that never reaches the user).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Who gets it. Admins only (email addresses are personal).
create table if not exists public.report_recipients (
  email text primary key check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  name text,
  active boolean not null default true,
  note text,
  added_at timestamptz not null default now()
);
-- Every run (scheduler or Admin test): what was sent, to whom, problems.
create table if not exists public.monthly_reports (
  id bigint generated always as identity primary key,
  period_key text not null,             -- 'YYYY-MM'
  action text not null,                 -- monthly / send / preview
  requested_by text,
  file_path text,                       -- in bucket monthly-reports
  sent_to text[] not null default '{}',
  status text not null,                 -- sent / built / not_sent / failed
  error text,
  freedom_lines int,
  renson_lines int,
  created_at timestamptz not null default now()
);
-- Month-end stock values (recorded by the scheduled run only), so next month's
-- report has an exact start-of-month value.
create table if not exists public.stock_value_snapshots (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('month_end')),
  period_key text not null,
  inventory text not null,
  value numeric not null,
  items int,
  taken_at timestamptz not null default now(),
  unique (kind, period_key, inventory)
);

do $$ declare t text; begin
  foreach t in array array['report_recipients', 'monthly_reports', 'stock_value_snapshots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'report_recipients' and policyname = 'report_recipients_admin_read') then
    create policy report_recipients_admin_read on public.report_recipients for select to authenticated using (public.is_admin());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'monthly_reports' and policyname = 'monthly_reports_staff_read') then
    create policy monthly_reports_staff_read on public.monthly_reports for select to authenticated using (public.is_active_staff());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stock_value_snapshots' and policyname = 'stock_value_snapshots_staff_read') then
    create policy stock_value_snapshots_staff_read on public.stock_value_snapshots for select to authenticated using (public.is_active_staff());
  end if;
end $$;

-- Private bucket for the Excel files (written by the Edge Function only).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('monthly-reports', 'monthly-reports', false, 10485760, array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'monthly_reports_staff_read') then
    create policy monthly_reports_staff_read on storage.objects for select to authenticated
      using (bucket_id = 'monthly-reports' and public.is_active_staff());
  end if;
end $$;

-- The scheduler's password: a random token kept in Vault (never shown, never
-- in this file). The scheduled job sends it; the Edge Function asks the
-- database whether it is right (service_role only).
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'monthly_report_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'monthly_report_token', 'Monthly report scheduler token');
  end if;
end $$;
create or replace function public.monthly_report_token_ok(p_token text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_token, '') <> '' and p_token = (select decrypted_secret from vault.decrypted_secrets where name = 'monthly_report_token');
$$;
revoke all on function public.monthly_report_token_ok(text) from public, anon, authenticated;
grant execute on function public.monthly_report_token_ok(text) to service_role;

-- The schedule: 02:00 UTC on the 1st = 06:00 Dubai. Re-running this file
-- replaces the job (cron.schedule with the same name updates it).
select cron.schedule('monthly-stock-report', '0 2 1 * *', $job$
  select net.http_post(
    url := 'https://ylhdsvwzqcshffwohhfy.supabase.co/functions/v1/monthly-report',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-report-token', (select decrypted_secret from vault.decrypted_secrets where name = 'monthly_report_token')),
    body := '{"action":"monthly"}'::jsonb,
    timeout_milliseconds := 120000);
$job$);

-- Recipients are set separately (data, not code):
--   insert into public.report_recipients (email, name, note) values ('...', '...', '...');
-- Switch the schedule off:  select cron.unschedule('monthly-stock-report');
