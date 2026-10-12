-- Minimum stock level per item ("Minimum level" box in the Master Inventory
-- item panel). Applied 2026-10-12.
--
-- The level lives in the existing column inventory_items.buffer_level, which
-- the site already reads for the "Low stock" badge / Low filter / exports
-- (stock <= level). Nothing else changes on the item: not the stock, not the
-- cost, not updated_at.
--
-- Only an active Admin can set it, and only through set_item_minimum()
-- (inventory_items has no write policy, so a direct update is refused).
-- Every change is kept in item_minimum_log (who, when, old -> new);
-- signed-in active staff can read it.

create table if not exists public.item_minimum_log (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.inventory_items (id) on delete cascade,
  old_level numeric,
  new_level numeric,
  set_by uuid references auth.users (id) on delete set null,
  set_by_name text,
  set_at timestamptz not null default now()
);
create index if not exists item_minimum_log_item_idx on public.item_minimum_log (item_id, set_at desc);
comment on table public.item_minimum_log is
  'Who changed an item''s minimum level (inventory_items.buffer_level). Written only by set_item_minimum().';

alter table public.item_minimum_log enable row level security;
revoke all on public.item_minimum_log from anon;
revoke insert, update, delete, truncate on public.item_minimum_log from authenticated;
grant select on public.item_minimum_log to authenticated;

drop policy if exists "Staff read minimum level changes" on public.item_minimum_log;
create policy "Staff read minimum level changes" on public.item_minimum_log
  for select to authenticated
  using ((select public.is_active_staff()));

-- p_level: a number above 0, or null to clear it ("Not set").
create or replace function public.set_item_minimum(p_item_id uuid, p_level numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old numeric;
  v_name text;
  v_at timestamptz := now();
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'error', 'not_admin');
  end if;
  if p_level is not null and (p_level <= 0 or p_level > 1000000000) then
    return jsonb_build_object('ok', false, 'error', 'invalid_level');
  end if;

  select buffer_level into v_old from public.inventory_items where id = p_item_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_such_item');
  end if;
  if v_old is not distinct from p_level then
    return jsonb_build_object('ok', true, 'changed', false, 'buffer_level', p_level);
  end if;

  update public.inventory_items set buffer_level = p_level where id = p_item_id;

  select coalesce(nullif(trim(full_name), ''), email) into v_name
  from public.user_profiles where user_id = auth.uid();
  insert into public.item_minimum_log (item_id, old_level, new_level, set_by, set_by_name, set_at)
  values (p_item_id, v_old, p_level, auth.uid(), v_name, v_at);

  return jsonb_build_object('ok', true, 'changed', true, 'buffer_level', p_level, 'set_by_name', v_name, 'set_at', v_at);
end;
$$;
revoke execute on function public.set_item_minimum(uuid, numeric) from public, anon;
grant execute on function public.set_item_minimum(uuid, numeric) to authenticated;
