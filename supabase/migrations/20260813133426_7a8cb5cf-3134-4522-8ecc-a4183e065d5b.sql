-- ============================================================
-- Landed Cost Reconstruction — Step 3: allocation engine
-- ============================================================

CREATE TABLE public.landed_cost_voucher_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  voucher_id uuid NOT NULL REFERENCES public.landed_cost_vouchers(id) ON DELETE CASCADE,
  goods_receipt_id uuid NOT NULL REFERENCES public.goods_receipts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (voucher_id, goods_receipt_id)
);

CREATE INDEX landed_cost_voucher_receipts_voucher_idx
  ON public.landed_cost_voucher_receipts(voucher_id);

GRANT SELECT, INSERT, DELETE ON public.landed_cost_voucher_receipts TO authenticated;
GRANT ALL ON public.landed_cost_voucher_receipts TO service_role;
ALTER TABLE public.landed_cost_voucher_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lc_voucher_receipts_read" ON public.landed_cost_voucher_receipts
  FOR SELECT TO authenticated
  USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "lc_voucher_receipts_write" ON public.landed_cost_voucher_receipts
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.landed_cost_vouchers v
                  WHERE v.id = voucher_id
                    AND public.user_has_business_access(auth.uid(), v.business_id)
                    AND v.status IN ('draft', 'pending_approval', 'allocated')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.landed_cost_vouchers v
                  WHERE v.id = voucher_id
                    AND public.user_has_business_access(auth.uid(), v.business_id)
                    AND v.status IN ('draft', 'pending_approval', 'allocated')));

COMMENT ON TABLE public.landed_cost_voucher_receipts IS
  'Shipment scope of a landed cost voucher: the goods receipts whose stock absorbs the charges.';

-- ------------------------------------------------------------
-- Keep component base amounts and voucher totals coherent
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._landed_cost_component_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_voucher RECORD;
  v_id uuid := COALESCE(NEW.voucher_id, OLD.voucher_id);
BEGIN
  SELECT * INTO v_voucher FROM public.landed_cost_vouchers WHERE id = v_id;
  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP <> 'DELETE' THEN
    NEW.organization_id := v_voucher.organization_id;
    NEW.business_id := v_voucher.business_id;
    NEW.base_amount := ROUND(NEW.amount * COALESCE(v_voucher.exchange_rate, 1), 2);
    RETURN NEW;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_lc_components_sync
  BEFORE INSERT OR UPDATE ON public.landed_cost_components
  FOR EACH ROW EXECUTE FUNCTION public._landed_cost_component_sync();

CREATE OR REPLACE FUNCTION public._landed_cost_voucher_recalc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := COALESCE(NEW.voucher_id, OLD.voucher_id);
BEGIN
  UPDATE public.landed_cost_vouchers v
     SET total_amount = COALESCE(t.amount, 0),
         total_base_amount = COALESCE(t.base_amount, 0)
    FROM (
      SELECT COALESCE(SUM(amount), 0) AS amount,
             COALESCE(SUM(base_amount), 0) AS base_amount
        FROM public.landed_cost_components WHERE voucher_id = v_id
    ) t
   WHERE v.id = v_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_lc_components_recalc
  AFTER INSERT OR UPDATE OR DELETE ON public.landed_cost_components
  FOR EACH ROW EXECUTE FUNCTION public._landed_cost_voucher_recalc();

-- ------------------------------------------------------------
-- Allocation engine
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landed_cost_allocate_voucher(
  p_voucher_id uuid,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  CREATE TEMP TABLE tmp_lc_targets ON COMMIT DROP AS
  SELECT gri.id AS gri_id,
         gr.id AS grn_id,
         gr.purchase_order_id,
         gri.product_id,
         COALESCE(gri.quantity_received, 0) AS qty,
         COALESCE(gri.quantity_received, 0) * COALESCE(poi.unit_price, 0) AS line_value
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

  DELETE FROM public.landed_cost_allocations WHERE voucher_id = p_voucher_id;

  FOR v_comp IN
    SELECT c.*, COALESCE(c.basis, v_voucher.default_basis) AS eff_basis
      FROM public.landed_cost_components c
     WHERE c.voucher_id = p_voucher_id AND c.amount > 0
     ORDER BY c.sort_order, c.created_at
  LOOP
    IF v_comp.eff_basis IN ('weight', 'volume') THEN
      RAISE EXCEPTION
        'component % uses % basis, but products carry no net %/unit master data — enter manual amounts instead',
        COALESCE(v_comp.description, v_comp.id::text), v_comp.eff_basis, v_comp.eff_basis
        USING ERRCODE = 'P0001';
    END IF;

    IF v_comp.eff_basis = 'manual' THEN
      -- Manual components keep whatever the user entered; nothing to compute.
      CONTINUE;
    END IF;

    v_amount := ROUND(v_comp.amount * COALESCE(v_voucher.exchange_rate, 1), 2);

    SELECT CASE WHEN v_comp.eff_basis = 'value' THEN COALESCE(SUM(line_value), 0)
                ELSE COALESCE(SUM(qty), 0) END
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
      v_share := CASE WHEN v_comp.eff_basis = 'value' THEN v_line.line_value ELSE v_line.qty END;
      IF v_share <= 0 THEN CONTINUE; END IF;

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
$$;

REVOKE ALL ON FUNCTION public.landed_cost_allocate_voucher(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.landed_cost_allocate_voucher(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.landed_cost_allocate_voucher(uuid, uuid) IS
  'Spreads landed cost components across inventory-eligible goods receipt lines in scope. Idempotent: re-running replaces prior allocations.';
