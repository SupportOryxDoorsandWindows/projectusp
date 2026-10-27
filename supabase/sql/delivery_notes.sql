-- Delivery notes (powder coating + finished goods), prepared from the FP Pro
-- job list of a confirmed Check-out (user's request 2026-10-27).
--
-- New tables only; nothing existing is changed. The stock functions, the
-- checkout Edge Function and inventory_transactions are untouched: a note is
-- prepared AFTER a Check-out succeeded, by the browser calling
-- prepare_delivery_notes(), which only accepts a job list whose fingerprint
-- (SHA-256) is already on a saved Check-out (source_document_hash). One note
-- of each kind per job list (unique), so preparing twice never duplicates.
--
-- Who does what (all through the functions below; no write policies):
--   active staff  read notes + history, prepare, edit a draft, confirm
--   confirm       checks the required fields and gives the DN number
--                 (own series "DN-SF-0001", so it never clashes with the DN
--                 numbers made in the current program)
--   correct       only Admins and the people in delivery_note_correctors
--                 (Renato); needs a reason; the version before is kept in
--                 delivery_note_history
-- Every table answers only is_active_staff(), like the rest of the site.
-- Applied 2026-10-27 through the Supabase connector without the DROP lines
-- (the connector times out on DROP; they only matter on a re-run).

create table if not exists public.delivery_notes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('powder_coating', 'finished_goods')),
  source_document_hash text not null check (source_document_hash ~ '^[0-9a-f]{64}$'),
  source_document_name text,
  job_number text not null,
  client text,
  dn_number text unique,
  delivery_address text,
  contact_no text,
  secondary_contact_no text,
  delivered_by text,
  delivery_date date,
  customer_ref text,
  ral_code text,
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  flags jsonb not null default '[]'::jsonb check (jsonb_typeof(flags) = 'array'),
  corrected_count integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_by_name text,
  updated_at timestamptz not null default now(),
  confirmed_by_name text,
  confirmed_at timestamptz,
  unique (source_document_hash, kind)
);
comment on table public.delivery_notes is
  'Powder coating / finished goods delivery notes, one of each per checked-out FP Pro job list (source_document_hash = inventory_transactions.source_document_hash). Written only through the delivery-note functions.';

create table if not exists public.delivery_note_history (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.delivery_notes (id) on delete cascade,
  action text not null check (action in ('prepared', 'confirmed', 'corrected')),
  reason text,
  before jsonb,
  by_id uuid references auth.users (id) on delete set null,
  by_name text,
  created_at timestamptz not null default now()
);
create index if not exists delivery_note_history_note on public.delivery_note_history (note_id, created_at);

create table if not exists public.delivery_note_correctors (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
comment on table public.delivery_note_correctors is
  'People (besides Admins) who may correct a confirmed delivery note. Set with set_delivery_note_corrector() (Admins).';

create sequence if not exists public.delivery_note_number_seq;

alter table public.delivery_notes enable row level security;
alter table public.delivery_note_history enable row level security;
alter table public.delivery_note_correctors enable row level security;
revoke all on public.delivery_notes, public.delivery_note_history, public.delivery_note_correctors from anon;
revoke all on public.delivery_notes, public.delivery_note_history, public.delivery_note_correctors from authenticated;
grant select on public.delivery_notes, public.delivery_note_history, public.delivery_note_correctors to authenticated;
revoke all on sequence public.delivery_note_number_seq from public, anon, authenticated;

drop policy if exists "Staff read delivery notes" on public.delivery_notes;
create policy "Staff read delivery notes" on public.delivery_notes
  for select to authenticated using ((select public.is_active_staff()));
drop policy if exists "Staff read delivery note history" on public.delivery_note_history;
create policy "Staff read delivery note history" on public.delivery_note_history
  for select to authenticated using ((select public.is_active_staff()));
drop policy if exists "Staff read delivery note correctors" on public.delivery_note_correctors;
create policy "Staff read delivery note correctors" on public.delivery_note_correctors
  for select to authenticated using ((select public.is_active_staff()));

-- ---------- helpers ----------
create or replace function public.can_correct_delivery_notes()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select public.is_active_staff()) and (
    (select public.is_admin())
    or exists (select 1 from public.delivery_note_correctors where user_id = (select auth.uid())));
$$;

create or replace function public.dn_actor_name()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(trim(full_name), ''), email) from public.user_profiles where user_id = (select auth.uid());
$$;

-- Lines: [{description (1-1000 chars), qty (> 0, < 1e6), comments?}], 1-300 of them.
create or replace function public.dn_clean_lines(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare v jsonb := '[]'::jsonb; l jsonb; d text; q numeric; c text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then raise exception 'lines_invalid'; end if;
  if jsonb_array_length(p) > 300 then raise exception 'too_many_lines'; end if;
  for l in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(l) <> 'object' then raise exception 'lines_invalid'; end if;
    d := trim(coalesce(l->>'description', ''));
    c := left(trim(coalesce(l->>'comments', '')), 1000);
    begin q := (l->>'qty')::numeric; exception when others then raise exception 'line_qty_invalid'; end;
    if d = '' or length(d) > 1000 then raise exception 'line_description_invalid'; end if;
    if q is null or q <= 0 or q >= 1000000 then raise exception 'line_qty_invalid'; end if;
    v := v || jsonb_build_array(jsonb_build_object('description', d, 'qty', q, 'comments', c));
  end loop;
  return v;
end $$;

-- Applies the editable fields of p to note n (only keys that are present).
create or replace function public.dn_apply_fields(n public.delivery_notes, p jsonb)
returns public.delivery_notes language plpgsql set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'fields_invalid'; end if;
  if p ? 'delivery_address' then n.delivery_address := left(trim(p->>'delivery_address'), 300); end if;
  if p ? 'contact_no' then n.contact_no := left(trim(p->>'contact_no'), 60); end if;
  if p ? 'secondary_contact_no' then n.secondary_contact_no := left(trim(p->>'secondary_contact_no'), 60); end if;
  if p ? 'delivered_by' then n.delivered_by := left(trim(p->>'delivered_by'), 120); end if;
  if p ? 'customer_ref' then n.customer_ref := left(trim(p->>'customer_ref'), 200); end if;
  if p ? 'ral_code' then n.ral_code := left(trim(p->>'ral_code'), 200); end if;
  if p ? 'delivery_date' then
    begin n.delivery_date := nullif(p->>'delivery_date', '')::date; exception when others then raise exception 'date_invalid'; end;
  end if;
  if p ? 'lines' then n.lines := public.dn_clean_lines(p->'lines'); end if;
  return n;
end $$;

create or replace function public.dn_missing(n public.delivery_notes)
returns text[] language sql immutable set search_path = '' as $$
  select array_remove(array[
    case when n.kind = 'powder_coating' and coalesce(trim(n.ral_code), '') = '' then 'ral_code' end,
    case when coalesce(trim(n.delivery_address), '') = '' then 'delivery_address' end,
    case when coalesce(trim(n.delivered_by), '') = '' then 'delivered_by' end,
    case when n.delivery_date is null then 'delivery_date' end,
    case when jsonb_array_length(n.lines) = 0 then 'lines' end
  ], null);
$$;

revoke execute on function public.dn_clean_lines(jsonb), public.dn_apply_fields(public.delivery_notes, jsonb),
  public.dn_missing(public.delivery_notes), public.dn_actor_name() from public, anon, authenticated;
revoke execute on function public.can_correct_delivery_notes() from public, anon;
grant execute on function public.can_correct_delivery_notes() to authenticated;

-- ---------- prepare (after a Check-out) ----------
-- p_notes: [{kind, lines, flags?, delivery_address?, contact_no?, secondary_contact_no?, ral_code?}]
create or replace function public.prepare_delivery_notes(p_hash text, p_job text, p_client text, p_doc_name text, p_notes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e jsonb; n public.delivery_notes; created int := 0; existing int := 0; new_id uuid; who text;
begin
  if not (select public.is_active_staff()) then raise exception 'not_allowed'; end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'hash_invalid'; end if;
  if not exists (select 1 from public.inventory_transactions where source_document_hash = p_hash and type = 'check_out') then
    raise exception 'no_checkout';
  end if;
  if p_notes is null or jsonb_typeof(p_notes) <> 'array' or jsonb_array_length(p_notes) not between 1 and 2 then raise exception 'notes_invalid'; end if;
  who := public.dn_actor_name();
  for e in select * from jsonb_array_elements(p_notes) loop
    if (e->>'kind') not in ('powder_coating', 'finished_goods') then raise exception 'kind_invalid'; end if;
    n := null;
    n.kind := e->>'kind';
    n := public.dn_apply_fields(n, e - 'kind' - 'flags' - 'delivered_by' - 'delivery_date');
    if jsonb_typeof(coalesce(e->'flags', '[]'::jsonb)) <> 'array' then raise exception 'flags_invalid'; end if;
    insert into public.delivery_notes (kind, source_document_hash, source_document_name, job_number, client, customer_ref,
        delivery_address, contact_no, secondary_contact_no, ral_code, lines, flags, created_by, created_by_name, updated_by_name)
      values (n.kind, p_hash, left(p_doc_name, 300), left(coalesce(nullif(trim(p_job), ''), '-'), 120), left(trim(p_client), 200),
        coalesce(n.customer_ref, left(trim(p_client), 200)),
        n.delivery_address, n.contact_no, n.secondary_contact_no, n.ral_code, coalesce(n.lines, '[]'::jsonb),
        coalesce(e->'flags', '[]'::jsonb), (select auth.uid()), who, who)
      on conflict (source_document_hash, kind) do nothing
      returning id into new_id;
    if new_id is null then existing := existing + 1;
    else
      created := created + 1;
      insert into public.delivery_note_history (note_id, action, by_id, by_name) values (new_id, 'prepared', (select auth.uid()), who);
    end if;
    new_id := null;
  end loop;
  return jsonb_build_object('created', created, 'existing', existing);
end $$;

-- ---------- edit a draft (not yet confirmed) ----------
create or replace function public.save_delivery_note(p_id uuid, p_fields jsonb)
returns public.delivery_notes language plpgsql security definer set search_path = '' as $$
declare n public.delivery_notes;
begin
  if not (select public.is_active_staff()) then raise exception 'not_allowed'; end if;
  select * into n from public.delivery_notes where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if n.dn_number is not null then raise exception 'already_confirmed'; end if;
  n := public.dn_apply_fields(n, p_fields);
  update public.delivery_notes set delivery_address = n.delivery_address, contact_no = n.contact_no,
      secondary_contact_no = n.secondary_contact_no, delivered_by = n.delivered_by, delivery_date = n.delivery_date,
      customer_ref = n.customer_ref, ral_code = n.ral_code, lines = n.lines,
      updated_by_name = public.dn_actor_name(), updated_at = now()
    where id = p_id returning * into n;
  return n;
end $$;

-- ---------- confirm: checks, then gives the DN number ----------
create or replace function public.confirm_delivery_note(p_id uuid, p_fields jsonb)
returns public.delivery_notes language plpgsql security definer set search_path = '' as $$
declare n public.delivery_notes; miss text[]; who text := public.dn_actor_name();
begin
  if not (select public.is_active_staff()) then raise exception 'not_allowed'; end if;
  select * into n from public.delivery_notes where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if n.dn_number is not null then raise exception 'already_confirmed'; end if;
  n := public.dn_apply_fields(n, coalesce(p_fields, '{}'::jsonb));
  miss := public.dn_missing(n);
  if cardinality(miss) > 0 then raise exception 'missing:%', array_to_string(miss, ','); end if;
  update public.delivery_notes set delivery_address = n.delivery_address, contact_no = n.contact_no,
      secondary_contact_no = n.secondary_contact_no, delivered_by = n.delivered_by, delivery_date = n.delivery_date,
      customer_ref = n.customer_ref, ral_code = n.ral_code, lines = n.lines,
      dn_number = 'DN-SF-' || lpad(nextval('public.delivery_note_number_seq')::text, 4, '0'),
      confirmed_by_name = who, confirmed_at = now(), updated_by_name = who, updated_at = now()
    where id = p_id returning * into n;
  insert into public.delivery_note_history (note_id, action, by_id, by_name) values (p_id, 'confirmed', (select auth.uid()), who);
  return n;
end $$;

-- ---------- correct a confirmed note (Admins + correctors), reason required ----------
create or replace function public.correct_delivery_note(p_id uuid, p_fields jsonb, p_reason text)
returns public.delivery_notes language plpgsql security definer set search_path = '' as $$
declare n public.delivery_notes; old public.delivery_notes; miss text[]; who text := public.dn_actor_name();
begin
  if not (select public.can_correct_delivery_notes()) then raise exception 'not_allowed'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  select * into n from public.delivery_notes where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if n.dn_number is null then raise exception 'not_confirmed'; end if;
  old := n;
  n := public.dn_apply_fields(n, p_fields);
  miss := public.dn_missing(n);
  if cardinality(miss) > 0 then raise exception 'missing:%', array_to_string(miss, ','); end if;
  update public.delivery_notes set delivery_address = n.delivery_address, contact_no = n.contact_no,
      secondary_contact_no = n.secondary_contact_no, delivered_by = n.delivered_by, delivery_date = n.delivery_date,
      customer_ref = n.customer_ref, ral_code = n.ral_code, lines = n.lines,
      corrected_count = n.corrected_count + 1, updated_by_name = who, updated_at = now()
    where id = p_id returning * into n;
  insert into public.delivery_note_history (note_id, action, reason, before, by_id, by_name)
    values (p_id, 'corrected', left(trim(p_reason), 1000),
      jsonb_build_object('delivery_address', old.delivery_address, 'contact_no', old.contact_no, 'secondary_contact_no', old.secondary_contact_no,
        'delivered_by', old.delivered_by, 'delivery_date', old.delivery_date, 'customer_ref', old.customer_ref, 'ral_code', old.ral_code, 'lines', old.lines),
      (select auth.uid()), who);
  return n;
end $$;

-- ---------- Admins: who else may correct ----------
create or replace function public.set_delivery_note_corrector(p_user uuid, p_allowed boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (select public.is_admin()) then raise exception 'not_allowed'; end if;
  if p_allowed then insert into public.delivery_note_correctors (user_id) values (p_user) on conflict do nothing;
  else delete from public.delivery_note_correctors where user_id = p_user; end if;
end $$;

revoke execute on function public.prepare_delivery_notes(text, text, text, text, jsonb), public.save_delivery_note(uuid, jsonb),
  public.confirm_delivery_note(uuid, jsonb), public.correct_delivery_note(uuid, jsonb, text),
  public.set_delivery_note_corrector(uuid, boolean) from public, anon;
grant execute on function public.prepare_delivery_notes(text, text, text, text, jsonb), public.save_delivery_note(uuid, jsonb),
  public.confirm_delivery_note(uuid, jsonb), public.correct_delivery_note(uuid, jsonb, text),
  public.set_delivery_note_corrector(uuid, boolean) to authenticated;
