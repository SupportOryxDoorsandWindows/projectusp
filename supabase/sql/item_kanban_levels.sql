-- Kanban replenishment levels per item ("Kanban" box in the Master Inventory
-- item panel). Applied 2026-10-14. Builds on item_minimum_level.sql.
--
-- Kanban trigger level = the existing column inventory_items.buffer_level
-- (was shown as "Minimum level"; same column, same values -- nothing is
-- renamed or reset). Stock <= trigger = Low stock (yellow row).
--
-- Critical level = NEW nullable column inventory_items.critical_level.
-- Stock <= critical = Critical stock (red row). Empty = no critical level:
-- the item is never "critical", only Low. It can only be set while a trigger
-- is set, and must be below it (a check constraint keeps that true).
--
-- Only an active Admin can set either, only through set_item_kanban_levels()
-- (inventory_items has no write policy). Every change goes to
-- item_minimum_log, now with level_kind = 'trigger' or 'critical'.
-- Nothing else on the item changes: not the stock, cost or updated_at.

alter table public.inventory_items
  add column if not exists critical_level numeric;
comment on column public.inventory_items.critical_level is
  'Kanban critical level: stock <= this = Critical (red). Null = none. Set only by set_item_kanban_levels().';
comment on column public.inventory_items.buffer_level is
  'Kanban trigger level (shown as "Kanban trigger level", was "Minimum level"): stock <= this = Low stock. Null = not set.';

alter table public.inventory_items drop constraint if exists inventory_items_critical_below_trigger;
alter table public.inventory_items add constraint inventory_items_critical_below_trigger
  check (critical_level is null or (buffer_level is not null and critical_level > 0 and critical_level < buffer_level));

alter table public.item_minimum_log
  add column if not exists level_kind text not null default 'trigger';
alter table public.item_minimum_log drop constraint if exists item_minimum_log_level_kind_check;
alter table public.item_minimum_log add constraint item_minimum_log_level_kind_check
  check (level_kind in ('trigger', 'critical'));
comment on table public.item_minimum_log is
  'Who changed an item''s Kanban levels (level_kind trigger = inventory_items.buffer_level, critical = critical_level). Written only by set_item_minimum() / set_item_kanban_levels().';

-- p_trigger: a number above 0, or null to clear it (which also clears the
-- critical level). p_critical: null for none, else above 0 and below p_trigger.
create or replace function public.set_item_kanban_levels(p_item_id uuid, p_trigger numeric, p_critical numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_trigger numeric;
  v_old_critical numeric;
  v_name text;
  v_at timestamptz := now();
begin
  if not public.is_admin() then
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
$$;
revoke execute on function public.set_item_kanban_levels(uuid, numeric, numeric) from public, anon;
grant execute on function public.set_item_kanban_levels(uuid, numeric, numeric) to authenticated;

-- The older set_item_minimum() (trigger only) stays for any page still open
-- from before this change. If it would leave the critical level at or above
-- the new trigger, the check constraint refuses the save.
