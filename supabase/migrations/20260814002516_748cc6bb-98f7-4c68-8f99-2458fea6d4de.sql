-- Phase 5D.1 — snapshot the landed cost allocation basis at allocation time
ALTER TABLE public.landed_cost_allocations
  ADD COLUMN IF NOT EXISTS basis_packaging_id uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS basis_qty numeric,
  ADD COLUMN IF NOT EXISTS basis_per_unit numeric,
  ADD COLUMN IF NOT EXISTS basis_uom_id uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN IF NOT EXISTS basis_snapshot_at timestamptz;

COMMENT ON COLUMN public.landed_cost_allocations.basis_per_unit IS
  'Measure per measured unit at allocation time, expressed in basis_uom_id. Historical snapshot: later edits to the product master must never change it.';

CREATE OR REPLACE FUNCTION public.landed_cost_allocate_voucher(p_voucher_id uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_voucher RECORD;
  v_actor uuid := COALESCE(p_actor, auth.uid());
  v_comp RECORD;
  v_line RECORD;
  v_basis_total numeric;
  v_amount numeric;
  v_running numeric;
  v_last_alloc uuid;
  v_share numeric;
  v_skipped jsonb := '[]'::jsonb;
  v_lines integer := 0;
  v_total_allocated numeric := 0;
  v_missing text;
  v_mass_uom uuid;
  v_volume_uom uuid;
  v_basis_uom uuid;
BEGIN
  SELECT * INTO v_voucher FROM public.landed_cost_vouchers WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'landed cost voucher % not found', p_voucher_id USING ERRCODE = 'P0002';
  END IF;

  IF v_actor IS NULL OR NOT public.user_has_business_access(v_actor, v_voucher.business_id) THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE = '42501';
  END IF;

  IF v_voucher.status NOT IN ('draft', 'pending_approval', 'allocated') THEN
    RAISE EXCEPTION 'voucher % is % and cannot be allocated', p_voucher_id, v_voucher.status
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.landed_cost_voucher_receipts WHERE voucher_id = p_voucher_id) THEN
    RAISE EXCEPTION 'voucher % has no goods receipts in scope', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.landed_cost_components WHERE voucher_id = p_voucher_id AND amount > 0) THEN
    RAISE EXCEPTION 'voucher % has no cost components to allocate', p_voucher_id USING ERRCODE = 'P0001';
  END IF;

  -- Reference units of the physical dimensions: resolve_product_measure returns
  -- values already converted to these, so they are the units the snapshot is in.
  SELECT reference_uom_id INTO v_mass_uom
    FROM public.uom_categories
   WHERE business_id = v_voucher.business_id AND dimension = 'mass'
     AND reference_uom_id IS NOT NULL
   ORDER BY created_at, id LIMIT 1;

  SELECT reference_uom_id INTO v_volume_uom
    FROM public.uom_categories
   WHERE business_id = v_voucher.business_id AND dimension = 'volume'
     AND reference_uom_id IS NOT NULL
   ORDER BY created_at, id LIMIT 1;

  -- Eligible target lines: inventory-tracked products received in scope.
  --
  -- Physical bases are measured at the level the line was actually received in:
  -- when the receipt line carries a packaging level and a display quantity, the
  -- measure is per package x number of packages. Otherwise it is the base-unit
  -- measure x base quantity. resolve_product_measure itself falls back from a
  -- packaging level to base x pack size, so a case always weighs a case.
  CREATE TEMP TABLE tmp_lc_targets ON COMMIT DROP AS
  WITH src AS (
    SELECT gri.id AS gri_id,
           gr.id AS grn_id,
           gr.purchase_order_id,
           gri.product_id,
           p.name AS product_name,
           COALESCE(gri.quantity_received, 0) AS qty,
           COALESCE(gri.quantity_received, 0) * COALESCE(poi.unit_price, 0) AS line_value,
           CASE
             WHEN gri.packaging_id IS NOT NULL AND COALESCE(gri.display_quantity, 0) > 0
               THEN gri.packaging_id
             ELSE NULL
           END AS measure_packaging_id,
           CASE
             WHEN gri.packaging_id IS NOT NULL AND COALESCE(gri.display_quantity, 0) > 0
               THEN gri.display_quantity
             ELSE COALESCE(gri.quantity_received, 0)
           END AS measure_qty
      FROM public.landed_cost_voucher_receipts lvr
      JOIN public.goods_receipts gr ON gr.id = lvr.goods_receipt_id
      JOIN public.goods_receipt_items gri ON gri.goods_receipt_id = gr.id
      JOIN public.products p ON p.id = gri.product_id
      LEFT JOIN public.purchase_order_items poi ON poi.id = gri.purchase_order_item_id
     WHERE lvr.voucher_id = p_voucher_id
       AND p.track_inventory IS TRUE
       AND COALESCE(gri.quantity_received, 0) > 0
  )
  SELECT src.gri_id,
         src.grn_id,
         src.purchase_order_id,
         src.product_id,
         src.product_name,
         src.qty,
         src.line_value,
         src.measure_packaging_id,
         src.measure_qty,
         COALESCE(
           public.resolve_product_measure(v_voucher.business_id, src.product_id, src.measure_packaging_id, 'gross_weight'),
           public.resolve_product_measure(v_voucher.business_id, src.product_id, src.measure_packaging_id, 'net_weight')
         ) AS weight_per_unit,
         public.resolve_product_measure(v_voucher.business_id, src.product_id, src.measure_packaging_id, 'volume')
           AS volume_per_unit,
         src.measure_qty * COALESCE(
           public.resolve_product_measure(v_voucher.business_id, src.product_id, src.measure_packaging_id, 'gross_weight'),
           public.resolve_product_measure(v_voucher.business_id, src.product_id, src.measure_packaging_id, 'net_weight')
         ) AS line_weight,
         src.measure_qty *
           public.resolve_product_measure(v_voucher.business_id, src.product_id, src.measure_packaging_id, 'volume')
           AS line_volume
    FROM src;

  SELECT jsonb_agg(jsonb_build_object(
           'goods_receipt_item_id', gri.id,
           'product_id', gri.product_id,
           'reason', CASE WHEN gri.product_id IS NULL THEN 'no_product'
                          WHEN COALESCE(gri.quantity_received, 0) <= 0 THEN 'zero_quantity'
                          ELSE 'not_inventory_tracked' END))
    INTO v_skipped
    FROM public.landed_cost_voucher_receipts lvr
    JOIN public.goods_receipt_items gri ON gri.goods_receipt_id = lvr.goods_receipt_id
    LEFT JOIN public.products p ON p.id = gri.product_id
   WHERE lvr.voucher_id = p_voucher_id
     AND (gri.product_id IS NULL
          OR p.track_inventory IS NOT TRUE
          OR COALESCE(gri.quantity_received, 0) <= 0);

  IF NOT EXISTS (SELECT 1 FROM tmp_lc_targets) THEN
    RAISE EXCEPTION 'no inventory-eligible receipt lines in scope for voucher %', p_voucher_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_voucher.exchange_rate IS NULL OR v_voucher.exchange_rate <= 0 THEN
    RAISE EXCEPTION
      'voucher % has no exchange rate on file for % — a landed cost cannot be allocated at parity',
      p_voucher_id, v_voucher.currency
      USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.landed_cost_allocations WHERE voucher_id = p_voucher_id;

  FOR v_comp IN
    SELECT c.*, COALESCE(c.basis, v_voucher.default_basis) AS eff_basis
      FROM public.landed_cost_components c
     WHERE c.voucher_id = p_voucher_id AND c.amount > 0
     ORDER BY c.sort_order, c.created_at
  LOOP
    IF v_comp.eff_basis = 'manual' THEN
      -- Manual components keep whatever the user entered; nothing to compute.
      CONTINUE;
    END IF;

    -- Fail closed when a physical basis is requested but the Product domain
    -- does not yet hold the fact for every line in scope.
    IF v_comp.eff_basis IN ('weight', 'volume') THEN
      SELECT string_agg(DISTINCT COALESCE(product_name, product_id::text), ', ')
        INTO v_missing
        FROM tmp_lc_targets
       WHERE CASE WHEN v_comp.eff_basis = 'weight' THEN line_weight ELSE line_volume END IS NULL
          OR CASE WHEN v_comp.eff_basis = 'weight' THEN line_weight ELSE line_volume END <= 0;

      IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
          'cannot allocate component % by %: no % recorded for %  — capture the product physical attributes first',
          COALESCE(v_comp.description, v_comp.id::text), v_comp.eff_basis, v_comp.eff_basis, v_missing
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    v_basis_uom := CASE v_comp.eff_basis
                     WHEN 'weight' THEN v_mass_uom
                     WHEN 'volume' THEN v_volume_uom
                     ELSE NULL
                   END;

    v_amount := ROUND(v_comp.amount * v_voucher.exchange_rate, 2);

    SELECT CASE v_comp.eff_basis
             WHEN 'value'  THEN COALESCE(SUM(line_value), 0)
             WHEN 'weight' THEN COALESCE(SUM(line_weight), 0)
             WHEN 'volume' THEN COALESCE(SUM(line_volume), 0)
             ELSE COALESCE(SUM(qty), 0)
           END
      INTO v_basis_total FROM tmp_lc_targets;

    IF v_basis_total <= 0 THEN
      RAISE EXCEPTION
        'cannot allocate component % by %: total basis is zero across the receipts in scope',
        COALESCE(v_comp.description, v_comp.id::text), v_comp.eff_basis
        USING ERRCODE = 'P0001';
    END IF;

    v_running := 0;
    v_last_alloc := NULL;

    FOR v_line IN SELECT * FROM tmp_lc_targets ORDER BY gri_id LOOP
      v_share := CASE v_comp.eff_basis
                   WHEN 'value'  THEN v_line.line_value
                   WHEN 'weight' THEN v_line.line_weight
                   WHEN 'volume' THEN v_line.line_volume
                   ELSE v_line.qty
                 END;
      IF v_share IS NULL OR v_share <= 0 THEN CONTINUE; END IF;

      INSERT INTO public.landed_cost_allocations (
        organization_id, business_id, voucher_id, component_id,
        goods_receipt_id, goods_receipt_item_id, purchase_order_id, product_id,
        basis, basis_value, allocation_ratio, allocated_amount,
        basis_packaging_id, basis_qty, basis_per_unit, basis_uom_id, basis_snapshot_at
      ) VALUES (
        v_voucher.organization_id, v_voucher.business_id, p_voucher_id, v_comp.id,
        v_line.grn_id, v_line.gri_id, v_line.purchase_order_id, v_line.product_id,
        v_comp.eff_basis, v_share, v_share / v_basis_total,
        ROUND(v_amount * v_share / v_basis_total, 2),
        CASE WHEN v_comp.eff_basis IN ('weight', 'volume') THEN v_line.measure_packaging_id END,
        CASE WHEN v_comp.eff_basis IN ('weight', 'volume') THEN v_line.measure_qty END,
        CASE v_comp.eff_basis
          WHEN 'weight' THEN v_line.weight_per_unit
          WHEN 'volume' THEN v_line.volume_per_unit
        END,
        v_basis_uom,
        now()
      ) RETURNING id, allocated_amount INTO v_last_alloc, v_share;

      v_running := v_running + v_share;
      v_lines := v_lines + 1;
    END LOOP;

    -- Absorb rounding drift on the final allocation of this component.
    IF v_last_alloc IS NOT NULL AND v_running <> v_amount THEN
      UPDATE public.landed_cost_allocations
         SET allocated_amount = allocated_amount + (v_amount - v_running)
       WHERE id = v_last_alloc;
    END IF;

    v_total_allocated := v_total_allocated + v_amount;
  END LOOP;

  -- Manual components: trust the amounts already captured against receipt lines.
  SELECT v_total_allocated + COALESCE(SUM(allocated_amount), 0)
    INTO v_total_allocated
    FROM public.landed_cost_allocations a
    JOIN public.landed_cost_components c ON c.id = a.component_id
   WHERE a.voucher_id = p_voucher_id AND a.is_manual IS TRUE;

  UPDATE public.landed_cost_vouchers
     SET status = 'allocated', allocated_at = now(), allocated_by = v_actor
   WHERE id = p_voucher_id;

  DROP TABLE IF EXISTS tmp_lc_targets;

  RETURN jsonb_build_object(
    'voucher_id', p_voucher_id,
    'status', 'allocated',
    'allocation_lines', v_lines,
    'allocated_amount', v_total_allocated,
    'skipped_lines', COALESCE(v_skipped, '[]'::jsonb)
  );
END;
$function$;

-- Posted allocation lines are history: nothing may rewrite or remove them.
CREATE OR REPLACE FUNCTION public._landed_cost_allocation_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT status::text INTO v_status
    FROM public.landed_cost_vouchers
   WHERE id = COALESCE(OLD.voucher_id, NEW.voucher_id);

  IF v_status IS DISTINCT FROM 'posted' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LANDED_COST_ALLOCATION_IMMUTABLE: allocation lines of a posted voucher cannot be deleted'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.voucher_id IS DISTINCT FROM OLD.voucher_id
     OR NEW.component_id IS DISTINCT FROM OLD.component_id
     OR NEW.goods_receipt_item_id IS DISTINCT FROM OLD.goods_receipt_item_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.basis IS DISTINCT FROM OLD.basis
     OR NEW.basis_value IS DISTINCT FROM OLD.basis_value
     OR NEW.basis_packaging_id IS DISTINCT FROM OLD.basis_packaging_id
     OR NEW.basis_qty IS DISTINCT FROM OLD.basis_qty
     OR NEW.basis_per_unit IS DISTINCT FROM OLD.basis_per_unit
     OR NEW.basis_uom_id IS DISTINCT FROM OLD.basis_uom_id
     OR NEW.allocation_ratio IS DISTINCT FROM OLD.allocation_ratio
     OR NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount THEN
    RAISE EXCEPTION 'LANDED_COST_ALLOCATION_IMMUTABLE: the allocation basis of a posted voucher cannot be changed — reverse the voucher instead'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_landed_cost_allocation_immutable ON public.landed_cost_allocations;
CREATE TRIGGER trg_landed_cost_allocation_immutable
BEFORE UPDATE OR DELETE ON public.landed_cost_allocations
FOR EACH ROW EXECUTE FUNCTION public._landed_cost_allocation_immutable();

-- Phase 5D.2 — physical attributes as a purchasing policy, not an allocation-time surprise
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS require_product_physical_attributes boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.businesses.require_product_physical_attributes IS
  'When true, a stock-tracked product with no physical attributes cannot be received. Off by default.';

CREATE OR REPLACE FUNCTION public.product_physical_attributes_required(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT require_product_physical_attributes
                     FROM public.businesses WHERE id = p_business_id), false);
$function$;

REVOKE EXECUTE ON FUNCTION public.product_physical_attributes_required(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.product_physical_attributes_required(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._enforce_receipt_product_physical_attributes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business uuid;
  v_name text;
  v_tracked boolean;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.business_id, p.name, p.track_inventory
    INTO v_business, v_name, v_tracked
    FROM public.products p WHERE p.id = NEW.product_id;

  IF v_tracked IS NOT TRUE OR NOT public.product_physical_attributes_required(v_business) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.product_physical_attributes pa
     WHERE pa.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION
      'PRODUCT_PHYSICAL_ATTRIBUTES_REQUIRED: % has no weight, volume or dimensions recorded — capture its physical attributes before receiving it',
      COALESCE(v_name, NEW.product_id::text)
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_receipt_product_physical_attributes ON public.goods_receipt_items;
CREATE TRIGGER trg_receipt_product_physical_attributes
BEFORE INSERT OR UPDATE OF product_id ON public.goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION public._enforce_receipt_product_physical_attributes();