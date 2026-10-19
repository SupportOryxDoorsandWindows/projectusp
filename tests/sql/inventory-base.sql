-- Stand-in stock tables (columns as on the live project, 2026-10-19), for
-- testing the stock functions on a LOCAL Postgres only. Load after
-- supabase-base.sql.
create table public.inventory_items (id uuid primary key default gen_random_uuid(), item_code text, description text,
  classification text default 'freedom', system_type text, category text, unit_of_measure text, bar_length_mm numeric,
  unit_cost numeric default 0, opening_qty numeric default 0, opening_value numeric default 0, current_qty numeric default 0,
  current_value numeric default 0, buffer_level numeric, status text default 'active', created_at timestamptz default now(),
  updated_at timestamptz default now(), pack_size_value numeric, pack_size_unit text, critical_level numeric);
create table public.inventory_transactions (id uuid primary key default gen_random_uuid(), type text, job_number text, client text,
  item_id uuid, item_code text, description text, quantity numeric, unit text, unit_cost_used numeric, value numeric,
  classification text, source_document_name text, source_document_hash text, created_at timestamptz default now(), supplier text,
  invoice_number text, po_number text, document_date date, original_currency text, original_unit_cost numeric, original_value numeric,
  exchange_rate numeric, rate_date date, rate_source text, approved_by text, is_new_item boolean default false, package_type text,
  package_qty numeric, qty_per_package numeric, package_unit text, package_cost numeric, shipping_cost_total numeric,
  shipping_allocated numeric, landed_unit_cost numeric, performed_by uuid, performed_by_name text, performed_by_email text);
create table public.exchange_rates (currency text primary key, rate_to_aed numeric, updated_at timestamptz default now());
do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$;
