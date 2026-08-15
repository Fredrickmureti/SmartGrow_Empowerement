-- =====================================================================
-- Phase 2 — historical immutability of UoM/packaging meaning.
--
-- `uom_snapshot` is decorative free text ("Bag × 50 KG"). It cannot be
-- recomputed, compared, or used to re-derive a base quantity, so a
-- packaging factor edit silently changes what a posted document meant.
-- This migration adds an ADDITIVE, structured snapshot next to it:
--   uom_snapshot_pack_name  - packaging name at posting time
--   uom_snapshot_factor     - base units per display unit at posting time
--   uom_snapshot_base_code  - product base UoM code at posting time
-- `uom_snapshot` is retained for display until every consumer migrates.
-- =====================================================================

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bill_items','credit_note_items','delivery_note_items','estimate_items',
    'goods_receipt_items','invoice_items','pos_transaction_items',
    'proforma_invoice_items','purchase_order_items','purchase_return_items',
    'sales_order_items','sales_return_items','stock_adjustment_items',
    'stock_transfer_items','vendor_credit_note_items'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I
         ADD COLUMN IF NOT EXISTS uom_snapshot_pack_name text,
         ADD COLUMN IF NOT EXISTS uom_snapshot_factor    numeric(20,8),
         ADD COLUMN IF NOT EXISTS uom_snapshot_base_code text', t);
    EXECUTE format(
      'COMMENT ON COLUMN public.%I.uom_snapshot_factor IS
       %L', t,
      'Base units per display unit, frozen at posting time. Machine-readable counterpart of uom_snapshot; never recomputed from product_packaging after the fact.');
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------
-- resolve_line_base_quantity: expose the structured parts it already
-- computes, so callers stop re-deriving them.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_line_base_quantity(
  p_business_id uuid, p_product_id uuid, p_display_quantity numeric,
  p_display_uom_id uuid DEFAULT NULL::uuid, p_packaging_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_base_uom   uuid;
  v_base_code  text;
  v_pack_qty   numeric;
  v_pack_prod  uuid;
  v_pack_name  text;
  v_base       numeric;
  v_snapshot   text;
  v_disp_code  text;
  v_factor     numeric;
BEGIN
  IF p_display_quantity IS NULL THEN
    RAISE EXCEPTION 'resolve_line_base_quantity: display quantity is required' USING ERRCODE = '22023';
  END IF;

  IF p_product_id IS NULL THEN
    RETURN jsonb_build_object(
      'base_quantity', p_display_quantity,
      'display_quantity', p_display_quantity,
      'display_uom_id', p_display_uom_id,
      'packaging_id', NULL,
      'base_uom_id', NULL,
      'uom_snapshot', NULL,
      'pack_name', NULL,
      'base_uom_code', NULL,
      'factor', 1);
  END IF;

  SELECT p.base_uom_id INTO v_base_uom
    FROM public.products p
   WHERE p.id = p_product_id
     AND (p_business_id IS NULL OR p.business_id = p_business_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_line_base_quantity: product % not found in business %',
      p_product_id, p_business_id USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(u.code, u.name) INTO v_base_code
    FROM public.units_of_measure u WHERE u.id = v_base_uom;

  IF p_packaging_id IS NOT NULL THEN
    SELECT pk.qty_in_base_uom, pk.product_id, pk.name
      INTO v_pack_qty, v_pack_prod, v_pack_name
      FROM public.product_packaging pk
     WHERE pk.id = p_packaging_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'resolve_line_base_quantity: packaging % not found', p_packaging_id
        USING ERRCODE = '22023';
    END IF;
    IF v_pack_prod IS DISTINCT FROM p_product_id THEN
      RAISE EXCEPTION 'resolve_line_base_quantity: packaging % does not belong to product %',
        p_packaging_id, p_product_id USING ERRCODE = '22023';
    END IF;
    IF COALESCE(v_pack_qty, 0) <= 0 THEN
      RAISE EXCEPTION 'resolve_line_base_quantity: packaging % has no positive qty_in_base_uom',
        p_packaging_id USING ERRCODE = '22023';
    END IF;
    -- Frozen label: "Bag × 50 KG" survives a later rename of the pack.
    v_snapshot := trim(concat_ws(' ', v_pack_name, '×',
                    trim(trailing '.' from trim(trailing '0' from to_char(v_pack_qty, 'FM9999999990.0999'))),
                    v_base_code));
    RETURN jsonb_build_object(
      'base_quantity', p_display_quantity * v_pack_qty,
      'display_quantity', p_display_quantity,
      'display_uom_id', p_display_uom_id,
      'packaging_id', p_packaging_id,
      'base_uom_id', v_base_uom,
      'uom_snapshot', v_snapshot,
      'pack_name', v_pack_name,
      'base_uom_code', v_base_code,
      'factor', v_pack_qty);
  END IF;

  IF p_display_uom_id IS NOT NULL AND v_base_uom IS NOT NULL
     AND p_display_uom_id <> v_base_uom THEN
    v_base := public.convert_uom(p_display_quantity, p_display_uom_id, v_base_uom);
    SELECT coalesce(u.code, u.name) INTO v_disp_code
      FROM public.units_of_measure u WHERE u.id = p_display_uom_id;
    -- Factor is derived from a UNIT conversion, not from the line quantity,
    -- so a zero-quantity line still carries a usable factor.
    v_factor := public.convert_uom(1, p_display_uom_id, v_base_uom);
    RETURN jsonb_build_object(
      'base_quantity', v_base,
      'display_quantity', p_display_quantity,
      'display_uom_id', p_display_uom_id,
      'packaging_id', NULL,
      'base_uom_id', v_base_uom,
      'uom_snapshot', v_disp_code,
      'pack_name', NULL,
      'base_uom_code', v_base_code,
      'factor', v_factor);
  END IF;

  SELECT coalesce(u.code, u.name) INTO v_snapshot
    FROM public.units_of_measure u
   WHERE u.id = COALESCE(p_display_uom_id, v_base_uom);
  RETURN jsonb_build_object(
    'base_quantity', p_display_quantity,
    'display_quantity', p_display_quantity,
    'display_uom_id', COALESCE(p_display_uom_id, v_base_uom),
    'packaging_id', NULL,
    'base_uom_id', v_base_uom,
    'uom_snapshot', v_snapshot,
    'pack_name', NULL,
    'base_uom_code', v_base_code,
    'factor', 1);
END
$function$;

-- ---------------------------------------------------------------------
-- enforce_line_uom_consistency: keep every existing guard, and stamp the
-- structured snapshot once, on the write that first creates it. Already
-- populated values are never overwritten — that is the immutability.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_line_uom_consistency()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_patch        jsonb := '{}'::jsonb;
  v_snap_factor  numeric;
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

  if v_packaging_id is not null then
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
      NEW.uom_snapshot := case
        when v_factor is not null and v_factor > 1
          then v_pack_name || ' × ' || v_factor::text || ' ' || v_base_label
        else v_pack_name
      end;
    end if;
  end if;

  -- ---- structured snapshot (Phase 2) --------------------------------
  -- Stamped only when absent. A later packaging rename or factor edit
  -- therefore cannot rewrite the meaning of an already-written line.
  if v_product_id is not null then
    if v_packaging_id is not null then
      v_snap_factor := coalesce(v_factor, 1);
    elsif v_display_uom is not null and v_base_uom_id is not null
          and v_display_uom <> v_base_uom_id then
      v_snap_factor := public.convert_uom(1, v_display_uom, v_base_uom_id);
    else
      v_snap_factor := 1;
    end if;

    if v_row ? 'uom_snapshot_factor' and v_row->>'uom_snapshot_factor' is null then
      v_patch := v_patch || jsonb_build_object('uom_snapshot_factor', v_snap_factor);
    end if;
    if v_row ? 'uom_snapshot_base_code' and v_row->>'uom_snapshot_base_code' is null then
      v_patch := v_patch || jsonb_build_object('uom_snapshot_base_code', v_base_label);
    end if;
    if v_row ? 'uom_snapshot_pack_name' and v_row->>'uom_snapshot_pack_name' is null
       and v_pack_name is not null then
      v_patch := v_patch || jsonb_build_object('uom_snapshot_pack_name', v_pack_name);
    end if;

    if v_patch <> '{}'::jsonb then
      NEW := jsonb_populate_record(NEW, to_jsonb(NEW) || v_patch);
    end if;
  end if;

  return NEW;
end;
$function$;

-- ---------------------------------------------------------------------
-- Backfill. Packaging-bearing lines take the pack's current factor;
-- everything else takes the product's base unit at factor 1 (or the
-- display UoM's conversion factor when one is set).
-- ---------------------------------------------------------------------
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bill_items','credit_note_items','delivery_note_items','estimate_items',
    'goods_receipt_items','invoice_items','pos_transaction_items',
    'proforma_invoice_items','purchase_order_items','purchase_return_items',
    'sales_order_items','sales_return_items','stock_adjustment_items',
    'stock_transfer_items','vendor_credit_note_items'
  ]
  LOOP
    -- Posted/approved lines are protected by immutability triggers. This
    -- backfill writes ONLY the new provenance columns — no quantity, price
    -- or status is touched — so user triggers are suspended for the window
    -- rather than weakening the guards themselves.
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t);

    EXECUTE format($sql$
      UPDATE public.%I l
         SET uom_snapshot_pack_name = pk.name,
             uom_snapshot_factor    = pk.qty_in_base_uom,
             uom_snapshot_base_code = coalesce(bu.code, bu.name)
        FROM public.product_packaging pk
        JOIN public.products p ON p.id = pk.product_id
        LEFT JOIN public.units_of_measure bu ON bu.id = p.base_uom_id
       WHERE l.packaging_id = pk.id
         AND l.uom_snapshot_factor IS NULL
    $sql$, t);

    EXECUTE format($sql$
      UPDATE public.%I l
         SET uom_snapshot_factor    = 1,
             uom_snapshot_base_code = coalesce(bu.code, bu.name)
        FROM public.products p
        LEFT JOIN public.units_of_measure bu ON bu.id = p.base_uom_id
       WHERE l.product_id = p.id
         AND l.packaging_id IS NULL
         AND l.uom_snapshot_factor IS NULL
         AND (l.display_uom_id IS NULL OR l.display_uom_id = p.base_uom_id)
         AND p.base_uom_id IS NOT NULL
    $sql$, t);

    EXECUTE format($sql$
      UPDATE public.%I l
         SET uom_snapshot_factor    = public.convert_uom(1, l.display_uom_id, p.base_uom_id),
             uom_snapshot_base_code = coalesce(bu.code, bu.name)
        FROM public.products p
        LEFT JOIN public.units_of_measure bu ON bu.id = p.base_uom_id
       WHERE l.product_id = p.id
         AND l.packaging_id IS NULL
         AND l.uom_snapshot_factor IS NULL
         AND p.base_uom_id IS NOT NULL
         AND EXISTS (
               SELECT 1
                 FROM public.units_of_measure du
                 JOIN public.units_of_measure bcat ON bcat.id = p.base_uom_id
                WHERE du.id = l.display_uom_id
                  AND du.category_id = bcat.category_id
             )
    $sql$, t);

    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', t);
  END LOOP;
END
$do$;