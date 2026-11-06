-- Kanban editors (2026-11-06, owner: "give anshad permission to edit the
-- kanban"; answers: "Kanban only", "Freedom and Renson").
--
-- A person who is NOT an Admin can be allowed to set Kanban trigger /
-- critical levels, and nothing else. Admins can always do it (as before).
--   * user_profiles.can_edit_kanban (default false)
--   * can_edit_kanban() = active account AND (Admin OR can_edit_kanban)
--   * set_item_kanban_levels() (Freedom) and renson_set_levels() (Renson):
--     ONLY their access check changes, from is_admin() to can_edit_kanban();
--     the rest is the live definition as of 2026-11-06 (md5 a07b2bb3... and
--     8e67adb3...). Every change is still logged with the person's name
--     (item_minimum_log / renson_items.levels_updated_by_name).
--   * admin_set_kanban_editor(user, on): Admins only; switches the
--     permission and writes account_activity_log ('kanban_access').
-- user_profiles has no write policy, so nobody can switch it on for
-- themselves. Stock, costs, Check-in / Check-out: untouched.
-- No DROP. Re-run safe.
--
-- GO BACK: run the two functions' previous definitions (git history of
-- item_kanban_levels.sql / renson_release.sql) or simply
--   update public.user_profiles set can_edit_kanban = false;
-- (Admins keep their access either way.)

alter table public.user_profiles
  add column if not exists can_edit_kanban boolean not null default false;
comment on column public.user_profiles.can_edit_kanban is
  'May set Kanban trigger / critical levels (Freedom + Renson) without being an Admin. Set only by admin_set_kanban_editor().';

create or replace function public.can_edit_kanban()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_profiles
    where user_id = (select auth.uid()) and active and (role = 'admin' or can_edit_kanban)
  );
$$;
revoke execute on function public.can_edit_kanban() from public, anon;
grant execute on function public.can_edit_kanban() to authenticated;

create or replace function public.admin_set_kanban_editor(p_user_id uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me record;
  v_t record;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'not_admin');
  end if;
  if p_on is null then
    return jsonb_build_object('ok', false, 'error', 'bad_value');
  end if;
  select user_id, email, full_name, can_edit_kanban into v_t from public.user_profiles where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_such_user');
  end if;
  if v_t.can_edit_kanban = p_on then
    return jsonb_build_object('ok', true, 'changed', false, 'can_edit_kanban', p_on);
  end if;
  update public.user_profiles set can_edit_kanban = p_on, updated_at = now(), updated_by = auth.uid() where user_id = p_user_id;
  select user_id, email, full_name into v_me from public.user_profiles where user_id = auth.uid();
  insert into public.account_activity_log (actor_id, actor_name, actor_email, action, target_email, target_name, detail)
  values (v_me.user_id, v_me.full_name, v_me.email, 'kanban_access', v_t.email, v_t.full_name,
          jsonb_build_object('can_edit_kanban', p_on));
  return jsonb_build_object('ok', true, 'changed', true, 'can_edit_kanban', p_on);
end;
$$;
revoke execute on function public.admin_set_kanban_editor(uuid, boolean) from public, anon;
grant execute on function public.admin_set_kanban_editor(uuid, boolean) to authenticated;

-- Freedom: live definition, access check only changed (was is_admin()).
CREATE OR REPLACE FUNCTION public.set_item_kanban_levels(p_item_id uuid, p_trigger numeric, p_critical numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_old_trigger numeric;
  v_old_critical numeric;
  v_name text;
  v_at timestamptz := now();
begin
  if not public.can_edit_kanban() then
    return jsonb_build_object('ok', false, 'error', 'not_admin');
  end if;
  if p_trigger is not null and (p_trigger <= 0 or p_trigger > 1000000000) then
    return jsonb_build_object('ok', false, 'error', 'invalid_level');
  end if;
  if p_critical is not null then
    if p_trigger is null then
      return jsonb_build_object('ok', false, 'error', 'critical_needs_trigger');
    end if;
    if p_critical <= 0 or p_critical >= p_trigger then
      return jsonb_build_object('ok', false, 'error', 'critical_not_below_trigger');
    end if;
  end if;

  select buffer_level, critical_level into v_old_trigger, v_old_critical
  from public.inventory_items where id = p_item_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_such_item');
  end if;
  if v_old_trigger is not distinct from p_trigger and v_old_critical is not distinct from p_critical then
    return jsonb_build_object('ok', true, 'changed', false, 'buffer_level', p_trigger, 'critical_level', p_critical);
  end if;

  update public.inventory_items set buffer_level = p_trigger, critical_level = p_critical where id = p_item_id;

  select coalesce(nullif(trim(full_name), ''), email) into v_name
  from public.user_profiles where user_id = auth.uid();
  if v_old_trigger is distinct from p_trigger then
    insert into public.item_minimum_log (item_id, level_kind, old_level, new_level, set_by, set_by_name, set_at)
    values (p_item_id, 'trigger', v_old_trigger, p_trigger, auth.uid(), v_name, v_at);
  end if;
  if v_old_critical is distinct from p_critical then
    insert into public.item_minimum_log (item_id, level_kind, old_level, new_level, set_by, set_by_name, set_at)
    values (p_item_id, 'critical', v_old_critical, p_critical, auth.uid(), v_name, v_at);
  end if;

  return jsonb_build_object('ok', true, 'changed', true, 'buffer_level', p_trigger, 'critical_level', p_critical,
    'set_by_name', v_name, 'set_at', v_at);
end;
$function$;

-- Renson: live definition, access check only changed (was renson_access() and is_admin()).
CREATE OR REPLACE FUNCTION public.renson_set_levels(p_item_code text, p_trigger numeric, p_critical numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t numeric := nullif(p_trigger, 0);
  v_c numeric := nullif(p_critical, 0);
  v_name text;
  v_id bigint;
begin
  if not (public.renson_access() and public.can_edit_kanban()) then
    raise exception 'renson_not_allowed' using errcode = '42501';
  end if;
  if v_t is not null and v_t < 0 then raise exception 'trigger_invalid'; end if;
  if v_c is not null and (v_c < 0 or v_t is null or v_c >= v_t) then raise exception 'critical_invalid'; end if;
  select coalesce(nullif(full_name, ''), email) into v_name from public.user_profiles where user_id = auth.uid();
  update public.renson_items set buffer_level = v_t, critical_level = v_c, levels_updated_at = now(), levels_updated_by_name = v_name
   where upper(item_code) = upper(trim(coalesce(p_item_code, ''))) returning id into v_id;
  if v_id is null then raise exception 'not_a_renson_item: %', p_item_code; end if;
  return jsonb_build_object('trigger', v_t, 'critical', v_c);
end $function$;
