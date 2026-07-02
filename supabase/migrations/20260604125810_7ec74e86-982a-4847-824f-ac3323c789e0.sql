
-- 1. Smarter line trigger: resolves base label from products + units_of_measure,
--    and validates display_uom_id category.
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
  v_display_uom  uuid;
  v_uom_snap     text;
  v_base_uom_id  uuid;
  v_base_cat     uuid;
  v_disp_cat     uuid;
  v_base_label   text;
  v_row          jsonb := to_jsonb(NEW);
begin
  v_product_id   := nullif(v_row->>'product_id','')::uuid;
  v_packaging_id := nullif(v_row->>'packaging_id','')::uuid;
  v_display_uom  := nullif(v_row->>'display_uom_id','')::uuid;
  v_display_qty  := nullif(v_row->>'display_quantity','')::numeric;
  v_uom_snap     := v_row->>'uom_snapshot';

  -- Resolve product's base UoM (for label + category coherence).
  if v_product_id is not null then
    select base_uom_id into v_base_uom_id
    from public.products where id = v_product_id;
    if v_base_uom_id is not null then
      select coalesce(u.code, u.name, 'ea'), u.category_id
        into v_base_label, v_base_cat
      from public.units_of_measure u where u.id = v_base_uom_id;
    end if;
  end if;
  v_base_label := coalesce(v_base_label, 'ea');

  -- display_uom_id must live in the same UoM category as the base UoM.
  if v_display_uom is not null and v_base_cat is not null then
    select category_id into v_disp_cat
      from public.units_of_measure where id = v_display_uom;
    if v_disp_cat is distinct from v_base_cat then
      raise exception 'display_uom_id % is in category % but product base is in category %',
        v_display_uom, v_disp_cat, v_base_cat using errcode = '23514';
    end if;
  end if;

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

  v_base_qty_col := case TG_TABLE_NAME
    when 'delivery_note_items'    then 'quantity_delivered'
    when 'goods_receipt_items'    then 'quantity_received'
    when 'stock_adjustment_items' then null
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

-- 2. stock_movements provenance guard.
create or replace function public.enforce_stock_movement_provenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_pack_product uuid;
begin
  if NEW.source_packaging_id is null or NEW.product_id is null then
    return NEW;
  end if;
  select product_id into v_pack_product
    from public.product_packaging where id = NEW.source_packaging_id;
  if v_pack_product is not null and v_pack_product <> NEW.product_id then
    raise exception 'source_packaging_id % belongs to product %, movement product is %',
      NEW.source_packaging_id, v_pack_product, NEW.product_id using errcode = '23514';
  end if;
  return NEW;
end;
$$;

drop trigger if exists enforce_stock_movement_provenance on public.stock_movements;
create trigger enforce_stock_movement_provenance
  before insert or update of source_packaging_id, product_id on public.stock_movements
  for each row execute function public.enforce_stock_movement_provenance();

-- 3. Back-fill uom_snapshot on legacy rows across all 14 line tables.
do $$
declare
  t text;
  tables text[] := array[
    'bill_items','credit_note_items','delivery_note_items','estimate_items',
    'goods_receipt_items','invoice_items','pos_transaction_items',
    'purchase_order_items','purchase_return_items','sales_order_items',
    'sales_return_items','stock_adjustment_items','stock_transfer_items',
    'vendor_credit_note_items'
  ];
begin
  foreach t in array tables loop
    execute format($f$
      update public.%I li
         set uom_snapshot = case
           when pp.qty_in_base_uom > 1
             then pp.name || ' × ' || pp.qty_in_base_uom::text || ' ' ||
                  coalesce(u.code, u.name, 'ea')
           else pp.name
         end
        from public.product_packaging pp
        left join public.products p on p.id = pp.product_id
        left join public.units_of_measure u on u.id = p.base_uom_id
       where li.packaging_id = pp.id
         and (li.uom_snapshot is null or li.uom_snapshot = '')
    $f$, t);
  end loop;
end$$;
