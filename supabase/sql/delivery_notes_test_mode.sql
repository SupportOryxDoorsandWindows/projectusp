-- Delivery notes: Admin-only TEST mode (user's request 2026-10-28: "test the
-- DN prototype without affecting the actual inventory"). Run AFTER
-- delivery_notes.sql; it replaces the functions it names below.
--
-- A test note is prepared from ANY FP Pro job list (no Check-out needed, so no
-- stock is ever involved), is marked is_test, numbered from its own series
-- TEST-0001 (the real DN-SF numbers are never used up), visible and usable
-- only by Admins, and can be deleted by Admins (a real note never can).
-- A job list tested first can still get its real notes when it is checked
-- out: the one-of-each-kind rule is now per (job list, kind, test or real).

alter table public.delivery_notes add column if not exists is_test boolean not null default false;

alter table public.delivery_notes drop constraint if exists delivery_notes_source_document_hash_kind_key;
alter table public.delivery_notes drop constraint if exists delivery_notes_hash_kind_test_key;
alter table public.delivery_notes add constraint delivery_notes_hash_kind_test_key unique (source_document_hash, kind, is_test);

create sequence if not exists public.delivery_note_test_number_seq;
revoke all on sequence public.delivery_note_test_number_seq from public, anon, authenticated;

-- Test notes (and their history) are seen by Admins only.
alter policy "Staff read delivery notes" on public.delivery_notes
  using ((select public.is_active_staff()) and (not is_test or (select public.is_admin())));
alter policy "Staff read delivery note history" on public.delivery_note_history
  using ((select public.is_active_staff()) and exists (
    select 1 from public.delivery_notes d where d.id = note_id and (not d.is_test or (select public.is_admin()))));

-- Shared by the real and the test prepare: the same reading, the same rules.
create or replace function public.dn_insert_notes(p_hash text, p_job text, p_client text, p_doc_name text, p_notes jsonb, p_test boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e jsonb; n public.delivery_notes; created int := 0; existing int := 0; new_id uuid; who text := public.dn_actor_name();
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'hash_invalid'; end if;
  if p_notes is null or jsonb_typeof(p_notes) <> 'array' or jsonb_array_length(p_notes) not between 1 and 2 then raise exception 'notes_invalid'; end if;
  for e in select * from jsonb_array_elements(p_notes) loop
    if (e->>'kind') not in ('powder_coating', 'finished_goods') then raise exception 'kind_invalid'; end if;
    n := null;
    n.kind := e->>'kind';
    n := public.dn_apply_fields(n, e - 'kind' - 'flags' - 'delivered_by' - 'delivery_date');
    if jsonb_typeof(coalesce(e->'flags', '[]'::jsonb)) <> 'array' then raise exception 'flags_invalid'; end if;
    insert into public.delivery_notes (kind, source_document_hash, source_document_name, job_number, client, customer_ref,
        delivery_address, contact_no, secondary_contact_no, ral_code, lines, flags, is_test, created_by, created_by_name, updated_by_name)
      values (n.kind, p_hash, left(p_doc_name, 300), left(coalesce(nullif(trim(p_job), ''), '-'), 120), left(trim(p_client), 200),
        coalesce(n.customer_ref, left(trim(p_client), 200)),
        n.delivery_address, n.contact_no, n.secondary_contact_no, n.ral_code, coalesce(n.lines, '[]'::jsonb),
        coalesce(e->'flags', '[]'::jsonb), p_test, (select auth.uid()), who, who)
      on conflict (source_document_hash, kind, is_test) do nothing
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
revoke execute on function public.dn_insert_notes(text, text, text, text, jsonb, boolean) from public, anon, authenticated;

-- Real notes: unchanged rules (active staff, a saved Check-out of this job list).
create or replace function public.prepare_delivery_notes(p_hash text, p_job text, p_client text, p_doc_name text, p_notes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not (select public.is_active_staff()) then raise exception 'not_allowed'; end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'hash_invalid'; end if;
  if not exists (select 1 from public.inventory_transactions where source_document_hash = p_hash and type = 'check_out') then
    raise exception 'no_checkout';
  end if;
  return public.dn_insert_notes(p_hash, p_job, p_client, p_doc_name, p_notes, false);
end $$;

-- Test notes: Admins only, any job list, no Check-out.
create or replace function public.prepare_delivery_test_notes(p_hash text, p_job text, p_client text, p_doc_name text, p_notes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not ((select public.is_active_staff()) and (select public.is_admin())) then raise exception 'not_allowed'; end if;
  return public.dn_insert_notes(p_hash, p_job, p_client, p_doc_name, p_notes, true);
end $$;

-- A test note may only be touched by an Admin.
create or replace function public.dn_check_access(n public.delivery_notes)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select public.is_active_staff()) then raise exception 'not_allowed'; end if;
  if n.is_test and not (select public.is_admin()) then raise exception 'not_allowed'; end if;
end $$;
revoke execute on function public.dn_check_access(public.delivery_notes) from public, anon, authenticated;

create or replace function public.save_delivery_note(p_id uuid, p_fields jsonb)
returns public.delivery_notes language plpgsql security definer set search_path = '' as $$
declare n public.delivery_notes;
begin
  if not (select public.is_active_staff()) then raise exception 'not_allowed'; end if;
  select * into n from public.delivery_notes where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  perform public.dn_check_access(n);
  if n.dn_number is not null then raise exception 'already_confirmed'; end if;
  n := public.dn_apply_fields(n, p_fields);
  update public.delivery_notes set delivery_address = n.delivery_address, contact_no = n.contact_no,
      secondary_contact_no = n.secondary_contact_no, delivered_by = n.delivered_by, delivery_date = n.delivery_date,
      customer_ref = n.customer_ref, ral_code = n.ral_code, lines = n.lines,
      updated_by_name = public.dn_actor_name(), updated_at = now()
    where id = p_id returning * into n;
  return n;
end $$;

create or replace function public.confirm_delivery_note(p_id uuid, p_fields jsonb)
returns public.delivery_notes language plpgsql security definer set search_path = '' as $$
declare n public.delivery_notes; miss text[]; who text := public.dn_actor_name();
begin
  if not (select public.is_active_staff()) then raise exception 'not_allowed'; end if;
  select * into n from public.delivery_notes where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  perform public.dn_check_access(n);
  if n.dn_number is not null then raise exception 'already_confirmed'; end if;
  n := public.dn_apply_fields(n, coalesce(p_fields, '{}'::jsonb));
  miss := public.dn_missing(n);
  if cardinality(miss) > 0 then raise exception 'missing:%', array_to_string(miss, ','); end if;
  update public.delivery_notes set delivery_address = n.delivery_address, contact_no = n.contact_no,
      secondary_contact_no = n.secondary_contact_no, delivered_by = n.delivered_by, delivery_date = n.delivery_date,
      customer_ref = n.customer_ref, ral_code = n.ral_code, lines = n.lines,
      dn_number = case when n.is_test
        then 'TEST-' || lpad(nextval('public.delivery_note_test_number_seq')::text, 4, '0')
        else 'DN-SF-' || lpad(nextval('public.delivery_note_number_seq')::text, 4, '0') end,
      confirmed_by_name = who, confirmed_at = now(), updated_by_name = who, updated_at = now()
    where id = p_id returning * into n;
  insert into public.delivery_note_history (note_id, action, by_id, by_name) values (p_id, 'confirmed', (select auth.uid()), who);
  return n;
end $$;

create or replace function public.correct_delivery_note(p_id uuid, p_fields jsonb, p_reason text)
returns public.delivery_notes language plpgsql security definer set search_path = '' as $$
declare n public.delivery_notes; old public.delivery_notes; miss text[]; who text := public.dn_actor_name();
begin
  if not (select public.can_correct_delivery_notes()) then raise exception 'not_allowed'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  select * into n from public.delivery_notes where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  perform public.dn_check_access(n);
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

-- Admins delete a TEST note (with its history). A real note is never deleted.
create or replace function public.delete_test_delivery_note(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t boolean;
begin
  if not ((select public.is_active_staff()) and (select public.is_admin())) then raise exception 'not_allowed'; end if;
  select is_test into t from public.delivery_notes where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if not t then raise exception 'not_a_test_note'; end if;
  delete from public.delivery_notes where id = p_id and is_test;
end $$;

revoke execute on function public.prepare_delivery_test_notes(text, text, text, text, jsonb), public.delete_test_delivery_note(uuid) from public, anon;
grant execute on function public.prepare_delivery_test_notes(text, text, text, text, jsonb), public.delete_test_delivery_note(uuid) to authenticated;
