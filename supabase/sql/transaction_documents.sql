-- Original PDFs kept with each Check-in / Check-out (applied 2026-10-12).
--
-- The file itself lives in the PRIVATE Storage bucket "transaction-documents"
-- at check-in/<sha256>.pdf or check-out/<sha256>.pdf. <sha256> is the same
-- fingerprint the transaction rows carry in
-- inventory_transactions.source_document_hash (the duplicate-PDF check), so a
-- kept file belongs to exactly the transaction lines confirmed from it.
--
-- Only the checkin/checkout Edge Functions (service_role) write here, and
-- only after the stock itself was saved. Signed-in active staff can read the
-- list and open a file through a short-lived signed link; nobody else can.
-- Nothing deletes these automatically.
-- (Applied through the Supabase connector in two parts without the DROP
-- lines -- the connector times out on DROP; they only matter on a re-run.)

create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles
    where user_id = (select auth.uid()) and active
  );
$$;
revoke execute on function public.is_active_staff() from public, anon;
grant execute on function public.is_active_staff() to authenticated;

create table if not exists public.transaction_documents (
  document_hash text primary key check (document_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('check_in', 'check_out')),
  storage_path text not null unique,
  file_name text,
  size_bytes bigint not null check (size_bytes > 0),
  uploaded_by uuid references auth.users (id) on delete set null,
  uploaded_by_name text,
  created_at timestamptz not null default now()
);
comment on table public.transaction_documents is
  'Original PDF kept for a Check-in/Check-out; document_hash = inventory_transactions.source_document_hash. Written only by the checkin/checkout Edge Functions.';

alter table public.transaction_documents enable row level security;
revoke all on public.transaction_documents from anon;
revoke insert, update, delete, truncate on public.transaction_documents from authenticated;
grant select on public.transaction_documents to authenticated;

drop policy if exists "Staff read kept documents" on public.transaction_documents;
create policy "Staff read kept documents" on public.transaction_documents
  for select to authenticated
  using ((select public.is_active_staff()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('transaction-documents', 'transaction-documents', false, 26214400, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Read (= create a signed link) for active staff. No insert/update/delete
-- policy: only the service_role (Edge Functions) can write.
drop policy if exists "Staff read transaction documents" on storage.objects;
create policy "Staff read transaction documents" on storage.objects
  for select to authenticated
  using (bucket_id = 'transaction-documents' and (select public.is_active_staff()));
