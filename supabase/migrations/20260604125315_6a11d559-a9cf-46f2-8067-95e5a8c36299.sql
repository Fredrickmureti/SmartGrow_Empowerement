
-- 1. Add uom_snapshot to remaining line tables (parity).
alter table public.invoice_items          add column if not exists uom_snapshot text;
alter table public.purchase_order_items   add column if not exists uom_snapshot text;
alter table public.goods_receipt_items    add column if not exists uom_snapshot text;
alter table public.sales_order_items      add column if not exists uom_snapshot text;
alter table public.stock_adjustment_items add column if not exists uom_snapshot text;
alter table public.stock_transfer_items   add column if not exists uom_snapshot text;

-- 2. Shared validation trigger.
create or replace function public.enforce_line_uom_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack_product uuid;
  v_pack_name    text;
  v_factor       numeric;
  v_base_qty_col text;
  v_base_qty     numeric;
  v_display_qty  numeric;
  v_product_id   uuid;
  v_packaging_id uuid;
  v_uom_snap     text;
  v_base_label   text := 'ea';
  v_row          jsonb := to_jsonb(NEW);
begin
  v_product_id   := (v_row->>'product_id')::uuid;
  v_packaging_id := nullif(v_row->>'packaging_id','')::uuid;
  v_display_qty  := nullif(v_row->>'display_quantity','')::numeric;
  v_uom_snap     := v_row->>'uom_snapshot';

  -- No packaging chosen → nothing to enforce.
  if v_packaging_id is null then
    return NEW;
  end if;

  select pp.product_id, pp.name, pp.qty_in_base_uom
    into v_pack_product, v_pack_name, v_factor
  from public.product_packaging pp
  where pp.id = v_packaging_id;

  if v_pack_product is null then
    raise exception 'packaging_id % does not exist', v_packaging_id
      using errcode = '23503';
  end if;

  if v_product_id is not null and v_pack_product <> v_product_id then
    raise exception 'packaging_id % belongs to product % but line product is %',
      v_packaging_id, v_pack_product, v_product_id
      using errcode = '23514';
  end if;

  -- Pick the per-table "base qty" column for the equality check.
  v_base_qty_col := case TG_TABLE_NAME
    when 'delivery_note_items'    then 'quantity_delivered'
    when 'goods_receipt_items'    then 'quantity_received'
    when 'stock_adjustment_items' then null  -- signed, skip equality
    when 'stock_transfer_items'   then 'quantity_sent'
    else 'quantity'
  end;

  if v_base_qty_col is not null and v_display_qty is not null then
    v_base_qty := nullif(v_row->>v_base_qty_col,'')::numeric;
    if v_base_qty is not null and abs(v_base_qty - v_display_qty * coalesce(v_factor,1)) > 0.0001 then
      raise exception
        'UoM mismatch on %: %=% but display_quantity=% × factor=% (expected %)',
        TG_TABLE_NAME, v_base_qty_col, v_base_qty,
        v_display_qty, v_factor, (v_display_qty * coalesce(v_factor,1))
        using errcode = '23514';
    end if;
  end if;

  -- Back-fill uom_snapshot when caller didn't supply one.
  if (v_uom_snap is null or v_uom_snap = '') and v_pack_name is not null then
    if v_factor is not null and v_factor > 1 then
      NEW.uom_snapshot := v_pack_name || ' × ' || v_factor::text || ' ' || v_base_label;
    else
      NEW.uom_snapshot := v_pack_name;
    end if;
  end if;

  return NEW;
end;
$$;

-- 3. Attach to every transactional line table that carries packaging_id + display_quantity.
do $$
declare t text;
begin
  foreach t in array array[
    'bill_items','credit_note_items','delivery_note_items','estimate_items',
    'goods_receipt_items','invoice_items','pos_transaction_items',
    'purchase_order_items','purchase_return_items','sales_order_items',
    'sales_return_items','stock_adjustment_items','stock_transfer_items',
    'vendor_credit_note_items'
  ] loop
    execute format('drop trigger if exists enforce_line_uom_consistency on public.%I', t);
    execute format(
      'create trigger enforce_line_uom_consistency
         before insert or update on public.%I
         for each row execute function public.enforce_line_uom_consistency()', t);
  end loop;
end$$;

-- 4. Product UoM-category coherence.
create or replace function public.enforce_product_uom_category()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_cat uuid;
  v_sales_cat uuid;
  v_purch_cat uuid;
begin
  if NEW.base_uom_id is null then
    return NEW;
  end if;
  select category_id into v_base_cat from public.units_of_measure where id = NEW.base_uom_id;
  if v_base_cat is null then return NEW; end if;

  if NEW.sales_uom_id is not null then
    select category_id into v_sales_cat from public.units_of_measure where id = NEW.sales_uom_id;
    if v_sales_cat is distinct from v_base_cat then
      raise exception 'sales_uom_id category (%) must match base_uom_id category (%)',
        v_sales_cat, v_base_cat using errcode = '23514';
    end if;
  end if;

  if NEW.purchase_uom_id is not null then
    select category_id into v_purch_cat from public.units_of_measure where id = NEW.purchase_uom_id;
    if v_purch_cat is distinct from v_base_cat then
      raise exception 'purchase_uom_id category (%) must match base_uom_id category (%)',
        v_purch_cat, v_base_cat using errcode = '23514';
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists enforce_product_uom_category on public.products;
create trigger enforce_product_uom_category
  before insert or update of base_uom_id, sales_uom_id, purchase_uom_id
  on public.products
  for each row execute function public.enforce_product_uom_category();

-- 5. Per-pack price / cost derivation functions (single source of truth).
create or replace function public.product_pack_price(p_product_id uuid, p_packaging_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.unit_price, 0) * coalesce(
           (select qty_in_base_uom
              from public.product_packaging
             where id = p_packaging_id and product_id = p_product_id),
           1)
  from public.products p
  where p.id = p_product_id;
$$;

create or replace function public.product_pack_cost(p_product_id uuid, p_packaging_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.cost_price, 0) * coalesce(
           (select qty_in_base_uom
              from public.product_packaging
             where id = p_packaging_id and product_id = p_product_id),
           1)
  from public.products p
  where p.id = p_product_id;
$$;

grant execute on function public.product_pack_price(uuid, uuid) to authenticated, service_role;
grant execute on function public.product_pack_cost(uuid, uuid)  to authenticated, service_role;
