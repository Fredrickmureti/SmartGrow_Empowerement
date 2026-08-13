-- ============================================================
-- Phase 2 — Landed Cost consumes canonical product physical facts.
-- No local measurement or conversion logic: resolve_product_measure only.
-- ============================================================

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

  -- Eligible target lines: inventory-tracked products received in scope.
  -- Physical bases are resolved once, per line, from the Product domain.
  CREATE TEMP TABLE tmp_lc_targets ON COMMIT DROP AS
  SELECT gri.id AS gri_id,
         gr.id AS grn_id,
         gr.purchase_order_id,
         gri.product_id,
         p.name AS product_name,
         COALESCE(gri.quantity_received, 0) AS qty,
         COALESCE(gri.quantity_received, 0) * COALESCE(poi.unit_price, 0) AS line_value,
         COALESCE(gri.quantity_received, 0) * COALESCE(
           public.resolve_product_measure(v_voucher.business_id, gri.product_id, NULL, 'gross_weight'),
           public.resolve_product_measure(v_voucher.business_id, gri.product_id, NULL, 'net_weight')
         ) AS line_weight,
         COALESCE(gri.quantity_received, 0) *
           public.resolve_product_measure(v_voucher.business_id, gri.product_id, NULL, 'volume') AS line_volume
    FROM public.landed_cost_voucher_receipts lvr
    JOIN public.goods_receipts gr ON gr.id = lvr.goods_receipt_id
    JOIN public.goods_receipt_items gri ON gri.goods_receipt_id = gr.id
    JOIN public.products p ON p.id = gri.product_id
    LEFT JOIN public.purchase_order_items poi ON poi.id = gri.purchase_order_item_id
   WHERE lvr.voucher_id = p_voucher_id
     AND p.track_inventory IS TRUE
     AND COALESCE(gri.quantity_received, 0) > 0;

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
        basis, basis_value, allocation_ratio, allocated_amount
      ) VALUES (
        v_voucher.organization_id, v_voucher.business_id, p_voucher_id, v_comp.id,
        v_line.grn_id, v_line.gri_id, v_line.purchase_order_id, v_line.product_id,
        v_comp.eff_basis, v_share, v_share / v_basis_total,
        ROUND(v_amount * v_share / v_basis_total, 2)
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
