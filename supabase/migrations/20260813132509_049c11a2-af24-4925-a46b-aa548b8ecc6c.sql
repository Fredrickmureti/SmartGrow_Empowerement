-- ============================================================
-- Landed Cost Reconstruction — Step 1: inventory valuation foundation
-- Value-only revaluation of cost layers (quantity untouched).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.inventory_cost_revaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  layer_id uuid NOT NULL REFERENCES public.cost_layers(id) ON DELETE RESTRICT,
  product_id uuid,
  warehouse_id uuid,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_line_id uuid,
  qty_remaining_at_apply numeric(18,6) NOT NULL,
  amount_applied numeric(18,4) NOT NULL,
  unit_cost_before numeric(18,6) NOT NULL,
  unit_cost_after numeric(18,6) NOT NULL,
  reversed_at timestamptz,
  reversed_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_cost_revaluations_idem
  ON public.inventory_cost_revaluations(source_type, source_id, layer_id)
  WHERE reversed_at IS NULL;

CREATE INDEX IF NOT EXISTS inventory_cost_revaluations_source_idx
  ON public.inventory_cost_revaluations(source_type, source_id);
CREATE INDEX IF NOT EXISTS inventory_cost_revaluations_layer_idx
  ON public.inventory_cost_revaluations(layer_id);

GRANT SELECT ON public.inventory_cost_revaluations TO authenticated;
GRANT ALL ON public.inventory_cost_revaluations TO service_role;

ALTER TABLE public.inventory_cost_revaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inventory_cost_revaluations_member_read"
  ON public.inventory_cost_revaluations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.business_id = inventory_cost_revaluations.business_id
  ));

DROP TRIGGER IF EXISTS trg_inventory_cost_revaluations_touch ON public.inventory_cost_revaluations;
CREATE TRIGGER trg_inventory_cost_revaluations_touch
  BEFORE UPDATE ON public.inventory_cost_revaluations
  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

COMMENT ON TABLE public.inventory_cost_revaluations IS
  'Provenance for value-only cost-layer revaluations (landed cost, cost corrections). One row per (source, layer).';

-- ------------------------------------------------------------
-- Engine: apply a value-only revaluation to the layers created
-- by one goods receipt line''s product/warehouse.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inventory_apply_cost_revaluation(
  p_goods_receipt_item_id uuid,
  p_amount numeric,
  p_source_type text,
  p_source_id uuid,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gri RECORD;
  v_qty_total numeric := 0;
  v_qty_remaining numeric := 0;
  v_capitalized numeric := 0;
  v_expensed numeric := 0;
  v_layer RECORD;
  v_share numeric;
  v_running numeric := 0;
  v_layers integer := 0;
  v_before numeric;
  v_after numeric;
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN
    RETURN jsonb_build_object('capitalized', 0, 'expensed', 0, 'layers', 0);
  END IF;

  SELECT gri.id, gri.product_id, gr.id AS grn_id, gr.warehouse_id,
         gr.organization_id, gr.business_id
    INTO v_gri
    FROM public.goods_receipt_items gri
    JOIN public.goods_receipts gr ON gr.id = gri.goods_receipt_id
   WHERE gri.id = p_goods_receipt_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'goods_receipt_item % not found', p_goods_receipt_item_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_gri.product_id IS NULL THEN
    RAISE EXCEPTION 'receipt line % has no product — not valuation eligible', p_goods_receipt_item_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Layers created by this receipt for this product/warehouse.
  CREATE TEMP TABLE tmp_reval_layers ON COMMIT DROP AS
  SELECT cl.id, cl.qty_total, cl.qty_remaining, cl.unit_cost
    FROM public.cost_layers cl
    JOIN public.stock_movements sm ON sm.id = cl.source_movement_id
   WHERE cl.business_id = v_gri.business_id
     AND cl.product_id = v_gri.product_id
     AND sm.reference_type = 'goods_receipt'
     AND sm.reference_id = v_gri.grn_id
     AND (v_gri.warehouse_id IS NULL OR cl.warehouse_id IS NOT DISTINCT FROM v_gri.warehouse_id);

  SELECT COALESCE(SUM(qty_total), 0), COALESCE(SUM(qty_remaining), 0)
    INTO v_qty_total, v_qty_remaining
    FROM tmp_reval_layers;

  IF v_qty_total <= 0 THEN
    -- Receipt never produced a cost layer (not stocked / not posted yet).
    RETURN jsonb_build_object(
      'capitalized', 0, 'expensed', ROUND(p_amount, 2), 'layers', 0,
      'reason', 'no_cost_layer'
    );
  END IF;

  v_capitalized := ROUND(p_amount * v_qty_remaining / v_qty_total, 2);
  v_expensed := ROUND(p_amount, 2) - v_capitalized;

  IF v_capitalized <> 0 AND v_qty_remaining > 0 THEN
    FOR v_layer IN
      SELECT * FROM tmp_reval_layers WHERE qty_remaining > 0 ORDER BY id
    LOOP
      v_layers := v_layers + 1;
      v_share := ROUND(v_capitalized * v_layer.qty_remaining / v_qty_remaining, 2);
      v_running := v_running + v_share;

      SELECT unit_cost INTO v_before FROM public.cost_layers WHERE id = v_layer.id FOR UPDATE;
      v_after := v_before + (v_share / v_layer.qty_remaining);

      UPDATE public.cost_layers SET unit_cost = v_after WHERE id = v_layer.id;

      INSERT INTO public.inventory_cost_revaluations (
        organization_id, business_id, layer_id, product_id, warehouse_id,
        source_type, source_id, source_line_id,
        qty_remaining_at_apply, amount_applied,
        unit_cost_before, unit_cost_after, created_by
      ) VALUES (
        v_gri.organization_id, v_gri.business_id, v_layer.id, v_gri.product_id, v_gri.warehouse_id,
        p_source_type, p_source_id, p_goods_receipt_item_id,
        v_layer.qty_remaining, v_share,
        v_before, v_after, COALESCE(p_actor, auth.uid())
      );
    END LOOP;

    -- Absorb rounding drift on the last touched layer.
    IF v_running <> v_capitalized THEN
      UPDATE public.inventory_cost_revaluations
         SET amount_applied = amount_applied + (v_capitalized - v_running)
       WHERE id = (
         SELECT id FROM public.inventory_cost_revaluations
          WHERE source_type = p_source_type AND source_id = p_source_id
            AND source_line_id = p_goods_receipt_item_id AND reversed_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 1
       );
    END IF;
  END IF;

  DROP TABLE IF EXISTS tmp_reval_layers;

  RETURN jsonb_build_object(
    'capitalized', v_capitalized,
    'expensed', v_expensed,
    'layers', v_layers,
    'qty_total', v_qty_total,
    'qty_remaining', v_qty_remaining
  );
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_apply_cost_revaluation(uuid, numeric, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_apply_cost_revaluation(uuid, numeric, text, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.inventory_apply_cost_revaluation(uuid, numeric, text, uuid, uuid) IS
  'Canonical value-only inventory revaluation. Raises cost_layers.unit_cost for remaining qty of a receipt line; returns the capitalized/expensed split. Quantity is never changed.';

-- ------------------------------------------------------------
-- Engine: reverse every revaluation booked by a source document.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inventory_reverse_cost_revaluation(
  p_source_type text,
  p_source_id uuid,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_qty numeric;
  v_reversed numeric := 0;
  v_count integer := 0;
BEGIN
  FOR v_row IN
    SELECT * FROM public.inventory_cost_revaluations
     WHERE source_type = p_source_type AND source_id = p_source_id
       AND reversed_at IS NULL
     FOR UPDATE
  LOOP
    SELECT qty_remaining INTO v_qty FROM public.cost_layers WHERE id = v_row.layer_id FOR UPDATE;

    IF v_qty IS NOT NULL AND v_qty > 0 THEN
      UPDATE public.cost_layers
         SET unit_cost = GREATEST(unit_cost - (v_row.amount_applied / v_qty), 0)
       WHERE id = v_row.layer_id;
    END IF;

    UPDATE public.inventory_cost_revaluations
       SET reversed_at = now(), reversed_by = COALESCE(p_actor, auth.uid())
     WHERE id = v_row.id;

    v_reversed := v_reversed + v_row.amount_applied;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('reversed_amount', v_reversed, 'layers', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_reverse_cost_revaluation(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_reverse_cost_revaluation(text, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.inventory_reverse_cost_revaluation(text, uuid, uuid) IS
  'Canonical reversal of value-only cost-layer revaluations booked by a source document.';
